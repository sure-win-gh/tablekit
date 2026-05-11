// Enquiry runner — takes a `received` enquiry through to
// `draft_ready` (or `failed` / `discarded`).
//
// Pipeline:
//   1. Atomic claim: UPDATE … WHERE status='received' FOR UPDATE
//      SKIP LOCKED. Wins exclusive ownership. Mirrors the import
//      runner pattern (lib/import/runner/writer.ts).
//   2. Decrypt body (envelope-encrypted under the org's DEK).
//   3. Call the Bedrock parser (lib/enquiries/parse.ts).
//      Permanent failures → status='failed', sanitised error.
//      Transient failures → leave at 'received', bump
//      parse_attempts, surface to the cron (it'll retry next tick).
//   4. If kind='not_a_booking_request': mark `discarded` with a
//      generic draft so the operator inbox shows a polite
//      acknowledgement.
//   5. Otherwise run availability via loadPublicAvailability. Top 3
//      slots feed into the template-based draft. Empty slot list
//      is OK — the draft offers a callback fallback.
//   6. Encrypt the parsed JSON + draft reply, persist alongside the
//      slots (plaintext jsonb), transition to `draft_ready`.
//
// IMPORTANT: this function uses `adminDb()` and BYPASSES RLS by
// design — it's a cron path with no user session. The atomic claim
// + RLS-protected reads via the venue's organisation make tenant
// isolation safe; the writer never touches data outside the
// claimed enquiry's org.
//
// Concurrency model: only ONE worker can win the claim because it
// transitions `status='received' → 'parsing'` with a strict WHERE.
// Orphaned 'parsing' rows (worker crashed mid-run) stay stuck until
// PR4's operator UI offers a "retry" button (resets to 'received').
// Same shape as the import runner.

import "server-only";

import { eq, sql } from "drizzle-orm";

import { enquiries, venues as venuesTable } from "@/lib/db/schema";
import { loadPublicAvailability, loadPublicVenue } from "@/lib/public/venue";
import { type Ciphertext, type Plaintext, decryptPii, encryptPii } from "@/lib/security/crypto";
import { adminDb } from "@/lib/server/admin/db";

import { generateDraft } from "./draft";
import { evaluateGuardrail, loadAutoSendEnabled } from "./guardrail";
import { applySendDraftPostSend } from "./operator-actions";
import { parseEnquiry } from "./parse";
import { checkEnquiryRateLimit } from "./rate-limit";
import { sanitiseEnquiryError } from "./sanitise-error";
import { resolveFromAddress, sendEnquiryReply } from "./send-reply";
import type { ParsedEnquiry, SuggestedSlot } from "./types";

import { audit } from "@/lib/server/admin/audit";

// Cap on parse attempts — every retry costs Bedrock tokens.
const MAX_PARSE_ATTEMPTS = 3;

// Reply-To address suffix for auto-sent replies — same value as
// app/api/webhooks/resend-inbound/route.ts INBOUND_DOMAIN. Duplicated
// rather than imported so the cron-time runner stays decoupled from
// the webhook route's module graph.
const INBOUND_DOMAIN = "enquiries.tablekit.uk";

export type ProcessResult =
  | { status: "draft_ready"; enquiryId: string }
  | { status: "auto_sent"; enquiryId: string }
  | { status: "discarded"; enquiryId: string }
  | { status: "failed"; enquiryId: string; error: string }
  | {
      status: "skipped";
      reason:
        | "not-found"
        | "locked"
        | "terminal"
        | "retry-pending"
        | "rate-limited-org"
        | "rate-limited-sender";
    };

export async function processEnquiry(enquiryId: string): Promise<ProcessResult> {
  const db = adminDb();

  // Pre-claim rate-limit check.
  //
  // Done BEFORE the claim so a rate-limit reject doesn't bump
  // parse_attempts (the cap on Bedrock-call retries) or transition
  // the row through 'parsing'. The row stays at 'received' and the
  // cron picks it up next tick once the window has rolled.
  //
  // Two reads on the row — this metadata fetch + the claim — but
  // the metadata is cached at the row-cache layer so the actual
  // overhead is one I/O. Worth it for the cleaner state machine.
  const [meta] = await db
    .select({
      organisationId: enquiries.organisationId,
      fromEmailHash: enquiries.fromEmailHash,
      status: enquiries.status,
    })
    .from(enquiries)
    .where(eq(enquiries.id, enquiryId));
  if (!meta) return { status: "skipped", reason: "not-found" };
  if (meta.status !== "received") return { status: "skipped", reason: "terminal" };

  const rl = await checkEnquiryRateLimit(meta.organisationId, meta.fromEmailHash);
  if (!rl.ok) {
    return {
      status: "skipped",
      reason: rl.bucket === "org" ? "rate-limited-org" : "rate-limited-sender",
    };
  }

  // Atomic claim. UPDATE the row to 'parsing' iff it's still
  // 'received' AND no other worker holds the row lock. The
  // FOR UPDATE SKIP LOCKED in the subselect prevents two workers
  // running concurrently from both seeing the row.
  type ClaimedRow = {
    id: string;
    organisationId: string;
    venueId: string;
    bodyCipher: string;
    parseAttempts: number;
  };
  const claimed = (await db.execute(sql`
    update enquiries
    set status = 'parsing',
        parse_attempts = parse_attempts + 1
    where id in (
      select id from enquiries
      where id = ${enquiryId}
        and status = 'received'
      for update skip locked
    )
    returning id,
              organisation_id as "organisationId",
              venue_id as "venueId",
              body_cipher as "bodyCipher",
              parse_attempts as "parseAttempts"
  `)) as unknown as { rows?: ClaimedRow[] } | ClaimedRow[];
  const claimedRows: ClaimedRow[] = Array.isArray(claimed) ? claimed : (claimed.rows ?? []);
  if (claimedRows.length === 0) {
    // Either not found, terminal, or locked. Read the row to decide.
    const [existing] = await db
      .select({ status: enquiries.status })
      .from(enquiries)
      .where(eq(enquiries.id, enquiryId));
    if (!existing) return { status: "skipped", reason: "not-found" };
    if (existing.status === "received") return { status: "skipped", reason: "locked" };
    return { status: "skipped", reason: "terminal" };
  }
  const job = claimedRows[0]!;

  try {
    // Decrypt the body. Plaintext lives only on the stack — no
    // logs, no audit metadata, no error chains.
    const bodyText = await decryptPii(job.organisationId, job.bodyCipher as Ciphertext);

    const parseResult = await parseEnquiry(bodyText);
    if (!parseResult.ok) {
      return await markParseOutcome(db, job, parseResult);
    }

    const parsed = parseResult.parsed;

    // Non-booking emails: short-circuit with a generic
    // acknowledgement. Status='discarded' so the operator inbox
    // can hide them by default.
    if (parsed.kind === "not_a_booking_request") {
      const venue = await loadPublicVenue(job.venueId);
      if (!venue) {
        // Venue evaporated mid-flight — fail rather than crash.
        return await markFailed(db, job, "venue not found");
      }
      const draft = generateDraft({ parsed, slots: [], venue });
      await persistDiscarded(db, job, parsed, draft);
      return { status: "discarded", enquiryId: job.id };
    }

    // Booking enquiry — run availability + draft a reply.
    const venue = await loadPublicVenue(job.venueId);
    if (!venue) {
      return await markFailed(db, job, "venue not found");
    }

    let slots: SuggestedSlot[] = [];
    if (parsed.requestedDate && parsed.partySize) {
      const availability = await loadPublicAvailability(venue, {
        date: parsed.requestedDate,
        partySize: parsed.partySize,
      });
      // Top 3 — the spec's "1–3 slots" rule. The availability engine
      // returns slots in time order; PR4 can re-rank by closeness to
      // the requested time window if needed.
      slots = availability.slots.slice(0, 3).map((s) => ({
        serviceId: s.serviceId,
        serviceName: s.serviceName,
        wallStart: s.wallStart,
        startAt: s.startAt.toISOString(),
        endAt: s.endAt.toISOString(),
      }));
    }

    const draft = generateDraft({ parsed, slots, venue });
    await persistDraftReady(db, job, parsed, slots, draft);

    // Auto-send branch. Venue-opt-in + guardrail-gated. Errors here
    // are intentionally swallowed: the draft already exists, so the
    // operator can still send manually — there's no graceful path to
    // surface an auto-send failure to the diner anyway. We don't
    // fail-roll-back to "received" because the parse already cost
    // Bedrock tokens.
    const finalStatus = await attemptAutoSend(db, job, parsed, slots.length, draft, bodyText);
    return { status: finalStatus, enquiryId: job.id };
  } catch (err) {
    // Catch-all — anything below the try shouldn't normally throw,
    // but if it does we sanitise + fail rather than 500 the cron.
    //
    // Sanitiser contract (per gdpr.md §Logs and error tracking):
    // errors that reach this catch MUST carry sanitisable text in
    // `.message`. Do NOT attach raw request/response payloads to
    // `.cause` — `sanitiseEnquiryError` only inspects `.message`.
    // If a future SDK adds payload chaining, extend the sanitiser
    // before relying on it here.
    return await markFailed(db, job, sanitiseEnquiryError(err));
  }
}

// Persist a successful booking-request parse + draft.
async function persistDraftReady(
  db: ReturnType<typeof adminDb>,
  job: { id: string; organisationId: string },
  parsed: ParsedEnquiry,
  slots: ReadonlyArray<SuggestedSlot>,
  draft: { subject: string; body: string },
): Promise<void> {
  const [parsedCipher, draftCipher] = await Promise.all([
    encryptPii(job.organisationId, JSON.stringify(parsed) as Plaintext),
    // We persist the body only — the subject is currently template-
    // derived from the venue name (no PII), so it doesn't need
    // ciphering. PR4's operator UI re-derives the subject when
    // sending. Keeping draftReply as a single ciphertext keeps the
    // schema small.
    encryptPii(job.organisationId, draft.body as Plaintext),
  ]);
  await db
    .update(enquiries)
    .set({
      status: "draft_ready",
      parsedCipher,
      suggestedSlots: slots,
      draftReplyCipher: draftCipher,
    })
    .where(eq(enquiries.id, job.id));
}

// Attempt to auto-send the freshly drafted reply on behalf of the
// operator. Two gates in series — venue opt-in then guardrail. The
// guardrail is the security-critical one (Article 9 + injection
// vectors); the venue opt-in is the business-decision lever.
//
// Returns the final status: "auto_sent" if we sent + flipped the
// row, otherwise "draft_ready" (unchanged from persistDraftReady).
// Never throws — a send failure leaves the operator their normal
// manual review path.
//
// PII posture (per gdpr.md §Logs):
//   - We decrypt the guest email + body for the duration of this
//     function only. Neither is stored, logged, or attached to audit
//     metadata.
//   - On failure we sanitise the error before logging; audit metadata
//     carries only correlation handles (enquiry id, guardrail reason).
async function attemptAutoSend(
  db: ReturnType<typeof adminDb>,
  job: { id: string; organisationId: string; venueId: string },
  parsed: ParsedEnquiry,
  slotCount: number,
  draft: { subject: string; body: string },
  rawBody: string,
): Promise<"draft_ready" | "auto_sent"> {
  // 1. Venue opt-in. Default false; a missing key means "off". Reads
  //    venues.settings via adminDb (no user session in this cron path).
  const enabled = await loadAutoSendEnabled(job.venueId);
  if (!enabled) return "draft_ready";

  // 2. Guardrail. Pure — no I/O. The guard tests every condition we
  //    care about (slot availability, Article-9 special requests,
  //    body length, reply chain, prompt-injection). Hold on any miss.
  const guardrail = evaluateGuardrail({ parsed, rawBody, slotCount });
  if (!guardrail.pass) {
    await audit.log({
      organisationId: job.organisationId,
      action: "enquiry.auto_sent_held",
      targetType: "enquiry",
      targetId: job.id,
      metadata: { venueId: job.venueId, reason: guardrail.reason },
    });
    return "draft_ready";
  }

  // 3. Resolve send context — guest email (encrypted) + the venue
  //    slug that owns the inbound Reply-To address. A venue without a
  //    slug can't have received this enquiry at all (the inbound
  //    webhook resolves by slug), so the null branch is defensive.
  const [row] = await db
    .select({
      fromEmailCipher: enquiries.fromEmailCipher,
    })
    .from(enquiries)
    .where(eq(enquiries.id, job.id));
  const [venueRow] = await db
    .select({ slug: venuesTable.slug })
    .from(venuesTable)
    .where(eq(venuesTable.id, job.venueId));
  if (!row || !venueRow?.slug) {
    return "draft_ready";
  }

  let guestEmail: string;
  try {
    guestEmail = await decryptPii(job.organisationId, row.fromEmailCipher as Ciphertext);
  } catch {
    // Crypto failure (key rotation mid-flight, etc.). Fall back to
    // manual review — operator can still send via the inbox.
    return "draft_ready";
  }

  const replyTo = `${venueRow.slug}@${INBOUND_DOMAIN}`;
  // Same resolver as the operator path — a verified per-venue domain
  // takes over, otherwise platform sender.
  const from = await resolveFromAddress(job.venueId);

  try {
    await sendEnquiryReply({
      from,
      to: guestEmail,
      replyTo,
      subject: draft.subject,
      body: draft.body,
      // Distinct key from the operator-action send so a manual click
      // after auto-send fires on a different idempotency lane.
      idempotencyKey: `enquiry-auto-send:${job.id}`,
    });
  } catch (err) {
    // Sanitised at the source (sendEnquiryReply wraps SDK errors
    // before throwing). Log + leave the draft for the operator.
    console.warn(`enquiry.auto_send.failed ${job.id} ${sanitiseEnquiryError(err)}`);
    return "draft_ready";
  }

  // Re-encrypt the body so the persisted ciphertext matches what
  // actually went out — mirrors the operator action's contract.
  const finalBodyCipher = await encryptPii(job.organisationId, draft.body as Plaintext);

  const result = await applySendDraftPostSend(db, {
    enquiryId: job.id,
    venueId: job.venueId,
    finalBodyCipher,
    repliedAt: new Date(),
  });
  if (result.rowsAffected === 0) {
    // Status no longer 'draft_ready' — extremely unlikely (no other
    // path flips it in this runner), but if it happened we already
    // sent the email. Caller still sees the draft as replied via the
    // operator UI later.
    return "draft_ready";
  }

  await audit.log({
    organisationId: job.organisationId,
    action: "enquiry.auto_sent",
    targetType: "enquiry",
    targetId: job.id,
    metadata: { venueId: job.venueId, slots: slotCount },
  });

  return "auto_sent";
}

// Persist a not-a-booking-request — same shape but status='discarded'
// and no slots.
async function persistDiscarded(
  db: ReturnType<typeof adminDb>,
  job: { id: string; organisationId: string },
  parsed: ParsedEnquiry,
  draft: { subject: string; body: string },
): Promise<void> {
  const [parsedCipher, draftCipher] = await Promise.all([
    encryptPii(job.organisationId, JSON.stringify(parsed) as Plaintext),
    encryptPii(job.organisationId, draft.body as Plaintext),
  ]);
  await db
    .update(enquiries)
    .set({
      status: "discarded",
      parsedCipher,
      suggestedSlots: [],
      draftReplyCipher: draftCipher,
    })
    .where(eq(enquiries.id, job.id));
}

// Branch on transient vs permanent parser errors. Transient: leave
// at 'received' so the cron retries next tick (up to MAX_PARSE_ATTEMPTS).
// Permanent: 'failed' with the sanitised reason.
async function markParseOutcome(
  db: ReturnType<typeof adminDb>,
  job: { id: string; parseAttempts: number },
  result: { ok: false; reason: "transient" | "permanent"; message: string },
): Promise<ProcessResult> {
  const sanitised = sanitiseEnquiryError(result.message);
  if (result.reason === "transient" && job.parseAttempts < MAX_PARSE_ATTEMPTS) {
    // Reset to 'received' so the cron picks it up again. The
    // parse_attempts counter has already been bumped by the claim.
    // Caller sees `retry-pending` (not `terminal`) so PR4's UI can
    // distinguish "we'll try again shortly" from "we're done".
    await db
      .update(enquiries)
      .set({ status: "received", error: sanitised })
      .where(eq(enquiries.id, job.id));
    return { status: "skipped", reason: "retry-pending" };
  }
  return await markFailed(db, job, sanitised);
}

async function markFailed(
  db: ReturnType<typeof adminDb>,
  job: { id: string },
  message: string,
): Promise<ProcessResult> {
  await db
    .update(enquiries)
    .set({ status: "failed", error: message })
    .where(eq(enquiries.id, job.id));
  return { status: "failed", enquiryId: job.id, error: message };
}

// Cron entry point. Picks up the oldest 'received' enquiry and
// hands it to processEnquiry. Loops up to `limit` times so a single
// tick can drain a small backlog before the function timeout.
export async function processNextEnquiries(
  opts: { limit?: number } = {},
): Promise<{ processed: ProcessResult[] }> {
  const limit = opts.limit ?? 10;
  const db = adminDb();
  const processed: ProcessResult[] = [];
  for (let i = 0; i < limit; i++) {
    const [next] = await db
      .select({ id: enquiries.id })
      .from(enquiries)
      .where(eq(enquiries.status, "received"))
      .orderBy(enquiries.receivedAt)
      .limit(1);
    if (!next) break;
    processed.push(await processEnquiry(next.id));
  }
  return { processed };
}
