// POST /api/webhooks/resend-inbound — Resend inbound email handler
// for the AI enquiry pipeline.
//
// Flow:
//   1. Verify Svix signature (RESEND_INBOUND_SECRET).
//   2. Idempotency: short-circuit if `svix-id` already seen
//      (inbound_webhook_events; INSERT ON CONFLICT DO NOTHING).
//   3. Extract `<slug>@enquiries.tablekit.uk` from the recipient
//      and verify the slug against the venue-slug regex (defends
//      against RFC-5321 quoted-locals / oversized inputs).
//   4. Resolve the venue → org via `loadPublicVenueByIdOrSlug`.
//   5. Require the org's plan to be `plus`.
//   6. Encrypt the from / subject / body fields under the org's DEK.
//   7. INSERT an `enquiries` row at status='received'.
//   8. Audit-log the event with NO plaintext PII in metadata.
//
// Drop-and-200-OK rules: an unknown slug, a non-Plus org, or any
// other "we don't want this" condition returns 200 with a logged
// `ignored` reason — do NOT 4xx. Resend would retry on a 4xx (or
// queue it as a bounce), neither of which we want for a no-op route.
//
// PII handling: the email body is untrusted free-form text. NEVER
// log it, NEVER include it in audit metadata, NEVER throw it back
// in an error message — every persistence path goes through
// `encryptPii`, every audit entry carries only the enquiry id +
// non-PII counts. Catch blocks rethrow as bland errors so a
// future verifier change can't echo body content into Sentry.

import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { InsufficientPlanError, OrgNotFoundError, requirePlan } from "@/lib/auth/require-plan";
import { enquiries, inboundWebhookEvents } from "@/lib/db/schema";
import {
  ResendInboundSecretMissingError,
  ResendInboundSignatureError,
  verifyResendInboundWebhook,
} from "@/lib/email/inbound-verify";
import { loadPublicVenueByIdOrSlug, resolveVenueOrg } from "@/lib/public/venue";
import { encryptPii, hashForLookup, type Plaintext } from "@/lib/security/crypto";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Resend's inbound payload shape — kept narrow on purpose so a
// schema drift surfaces as a "missing field" log rather than a
// runtime crash. We only read the fields we need.
type InboundEvent = {
  data?: {
    from?: { email?: string };
    to?: Array<{ email?: string }>;
    subject?: string;
    text?: string;
    // `html` is intentionally omitted — see comment near MAX_BODY_BYTES.
  };
};

// `<slug>@enquiries.tablekit.uk` — the catch-all on the inbound
// subdomain. Any other domain is rejected (the route is configured
// for one MX target; anything else is a misconfiguration upstream).
const INBOUND_DOMAIN = "enquiries.tablekit.uk";

// Slug shape — same regex the venue-slug feature enforces at the
// form layer + DB CHECK. Tighter than RFC 5321 local-parts on
// purpose: a sender-controlled string can otherwise exploit
// quoted-locals (`"a@b"@enquiries.tablekit.uk`) or oversized inputs.
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/;

// Reject inbound bodies above 256KB. Resend's stated cap is larger
// but the AI parser will choke and we'd burn Bedrock tokens for
// nothing. Enforced before `req.text()` to avoid buffering.
const MAX_BODY_BYTES = 256 * 1024;

export async function POST(req: NextRequest) {
  // Size guard — read Content-Length before consuming the body. Not
  // authoritative (a hostile client could lie), but Resend is
  // well-behaved and this avoids a multi-MB allocation in the
  // common-case bug.
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body-too-large" }, { status: 413 });
  }

  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body-too-large" }, { status: 413 });
  }

  const svixId = req.headers.get("svix-id");
  try {
    verifyResendInboundWebhook({
      body,
      svixId,
      svixTimestamp: req.headers.get("svix-timestamp"),
      svixSignature: req.headers.get("svix-signature"),
    });
  } catch (err) {
    if (err instanceof ResendInboundSecretMissingError) {
      return NextResponse.json({ error: "server-misconfigured" }, { status: 500 });
    }
    if (err instanceof ResendInboundSignatureError) {
      return NextResponse.json({ error: "bad-signature" }, { status: 400 });
    }
    // Unknown verifier failure — rethrow as a bland error so the body
    // can't leak via the original error's `message` or `cause` chain.
    throw new Error("verify-failed");
  }

  // Idempotency — Resend retries on transient errors and reuses the
  // same `svix-id`. `INSERT … ON CONFLICT DO NOTHING` returns 0 rows
  // on a duplicate; we short-circuit with 200 OK so the upstream
  // stops retrying.
  const db = adminDb();
  if (svixId) {
    const inserted = await db
      .insert(inboundWebhookEvents)
      .values({ eventId: svixId, provider: "resend-inbound" })
      .onConflictDoNothing()
      .returning({ eventId: inboundWebhookEvents.eventId });
    if (inserted.length === 0) {
      return NextResponse.json({ ok: true, ignored: "duplicate" });
    }
  }

  let event: InboundEvent;
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const fromEmail = event.data?.from?.email?.trim().toLowerCase();
  const toEmail = event.data?.to?.[0]?.email?.trim().toLowerCase();
  const subject = event.data?.subject?.trim() ?? "";
  // `html` is deliberately not consumed — gdpr-auditor flagged that
  // raw HTML carries tracking pixels + third-party URLs that
  // shouldn't land in our database even encrypted (they become live
  // again on decrypt). HTML-only inbound drops with `ignored:
  // 'no-text'`. A future PR can add a tested HTML-strip helper if
  // operators report missed enquiries.
  const bodyText = event.data?.text;

  if (!fromEmail || !toEmail) {
    return NextResponse.json({ ok: true, ignored: "missing-recipient-or-sender" });
  }
  if (!bodyText) {
    return NextResponse.json({ ok: true, ignored: "no-text" });
  }

  const slug = parseRecipientSlug(toEmail);
  if (!slug) {
    return NextResponse.json({ ok: true, ignored: "wrong-domain-or-bad-slug" });
  }

  const lookup = await loadPublicVenueByIdOrSlug(slug);
  if (!lookup || lookup.matchedBy !== "slug") {
    // `lookup.matchedBy === 'id'` would mean a sender used a UUID
    // local-part — slug regex above already filters UUIDs out, but
    // belt-and-braces.
    return NextResponse.json({ ok: true, ignored: "unknown-venue" });
  }

  const orgId = await resolveVenueOrg(lookup.venue.id);
  if (!orgId) {
    return NextResponse.json({ ok: true, ignored: "venue-without-org" });
  }

  try {
    await requirePlan(orgId, "plus");
  } catch (err) {
    if (err instanceof OrgNotFoundError) {
      // Org evaporated between resolveVenueOrg and the requirePlan
      // read (race; FK should make this unreachable, but defensive).
      // Don't audit — audit_log.organisation_id FK would reject
      // the insert and 500 the route.
      return NextResponse.json({ ok: true, ignored: "org-missing" });
    }
    if (err instanceof InsufficientPlanError) {
      // Drop with 200 — the venue exists but isn't entitled to the
      // feature. Audit-log the rejection (no PII — just internal
      // ids + reason). Operators upgrading to Plus will see this
      // and know inbound is being acknowledged.
      await audit.log({
        organisationId: orgId,
        actorUserId: null,
        action: "enquiry.rejected",
        targetType: "enquiry",
        targetId: lookup.venue.id,
        metadata: { reason: "not-entitled" },
      });
      return NextResponse.json({ ok: true, ignored: "not-entitled" });
    }
    throw new Error("plan-check-failed");
  }

  // Encrypt + hash. The hash on `from` lets the runner / dashboard
  // join enquiries to existing guests without decrypting either side
  // (mirrors the guests.email_hash pattern).
  const [fromCipher, subjectCipher, bodyCipher] = await Promise.all([
    encryptPii(orgId, fromEmail as Plaintext),
    encryptPii(orgId, subject as Plaintext),
    encryptPii(orgId, bodyText as Plaintext),
  ]);
  const fromEmailHash = hashForLookup(fromEmail, "email");

  const [row] = await db
    .insert(enquiries)
    .values({
      organisationId: orgId,
      venueId: lookup.venue.id,
      fromEmailHash,
      fromEmailCipher: fromCipher,
      subjectCipher,
      bodyCipher,
      // status defaults to 'received'; PR3's runner picks it up.
    })
    .returning({ id: enquiries.id });

  if (!row) {
    return NextResponse.json({ error: "insert-failed" }, { status: 500 });
  }

  // Audit metadata is intentionally PII-free: the enquiry id is the
  // durable handle for cross-referencing, the venue id is internal,
  // and `bodySize` is bucketed (small/medium/large) so log entries
  // can't be used as a fingerprint across retries. NO from / subject
  // / body / slug — those would echo guest input.
  await audit.log({
    organisationId: orgId,
    actorUserId: null,
    action: "enquiry.received",
    targetType: "enquiry",
    targetId: row.id,
    metadata: { venueId: lookup.venue.id, bodySize: bucketBodySize(bodyText.length) },
  });

  return NextResponse.json({ ok: true, enquiryId: row.id });
}

// `<slug>@enquiries.tablekit.uk` → `slug`. Returns null for any
// recipient on a different domain, a malformed address, or a
// slug that fails the venue-slug regex.
function parseRecipientSlug(recipient: string): string | null {
  const at = recipient.lastIndexOf("@");
  if (at < 0) return null;
  const domain = recipient.slice(at + 1);
  if (domain !== INBOUND_DOMAIN) return null;
  const local = recipient.slice(0, at);
  if (!SLUG_REGEX.test(local)) return null;
  return local;
}

// Coarse-grain size bucket so `bodyChars` can't double as a
// per-retry fingerprint. Three buckets cover the practical range.
function bucketBodySize(chars: number): "small" | "medium" | "large" {
  if (chars < 1024) return "small";
  if (chars < 16 * 1024) return "medium";
  return "large";
}
