// End-to-end test for the Resend inbound webhook route.
//
//   1. Seed an org + venue with a known slug, on the Plus plan.
//   2. Sign a fixture inbound payload with a test secret.
//   3. POST to the route handler (calling its exported `POST`
//      directly — no live HTTP needed).
//   4. Assert: enquiries row created, encrypted fields round-trip,
//      audit-log entry written WITHOUT plaintext PII.
//
// Also covers the drop-on-200-OK paths (unknown slug, non-Plus org)
// — the route must never 4xx these or Resend will retry / bounce.

import { createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { POST } from "@/app/api/webhooks/resend-inbound/route";
import { type Ciphertext, decryptPii, hashForLookup } from "@/lib/security/crypto";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const run = Date.now().toString(36);

// `whsec_<base64-of-32-random-bytes>` — same shape Resend hands you
// in the dashboard. Generated per-run so we don't conflict with any
// real secret in .env.local.
const TEST_SECRET_RAW = randomBytes(32);
const TEST_SECRET = "whsec_" + TEST_SECRET_RAW.toString("base64");

const ORIGINAL_INBOUND_SECRET = process.env["RESEND_INBOUND_SECRET"];

type Ctx = {
  plusOrgId: string;
  freeOrgId: string;
  plusVenueSlug: string;
  freeVenueSlug: string;
  plusVenueId: string;
  freeVenueId: string;
};
let ctx: Ctx;

// Each call gets a fresh svix-id by default — the route is now
// idempotent on `svix-id`, so a static id would make every test
// after the first see `ignored: 'duplicate'`. Pass a fixed id
// explicitly to test the dedup path itself.
let signCounter = 0;
function signPayload(
  body: string,
  secret: Buffer,
  fixedId?: string,
): {
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
} {
  const svixId = fixedId ?? `msg_${run}_${++signCounter}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", secret)
    .update(`${svixId}.${svixTimestamp}.${body}`)
    .digest("base64");
  return { svixId, svixTimestamp, svixSignature: `v1,${sig}` };
}

function makeRequest(body: string, headers: Record<string, string>): Request {
  return new Request("http://localhost/api/webhooks/resend-inbound", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function fixturePayload(opts: { to: string; from: string; subject: string; text: string }): string {
  return JSON.stringify({
    type: "inbound.email.received",
    data: {
      from: { email: opts.from },
      to: [{ email: opts.to }],
      subject: opts.subject,
      text: opts.text,
    },
  });
}

beforeAll(async () => {
  process.env["RESEND_INBOUND_SECRET"] = TEST_SECRET;

  const [plusOrg] = await db
    .insert(schema.organisations)
    .values({ name: `Inb-Plus ${run}`, slug: `inb-plus-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [freeOrg] = await db
    .insert(schema.organisations)
    .values({ name: `Inb-Free ${run}`, slug: `inb-free-${run}`, plan: "free" })
    .returning({ id: schema.organisations.id });
  if (!plusOrg || !freeOrg) throw new Error("org insert returned no row");

  const plusVenueSlug = `plus-cafe-${run}`;
  const freeVenueSlug = `free-cafe-${run}`;
  const [plusVenue] = await db
    .insert(schema.venues)
    .values({
      organisationId: plusOrg.id,
      name: "Plus Cafe",
      venueType: "cafe",
      slug: plusVenueSlug,
    })
    .returning({ id: schema.venues.id });
  const [freeVenue] = await db
    .insert(schema.venues)
    .values({
      organisationId: freeOrg.id,
      name: "Free Cafe",
      venueType: "cafe",
      slug: freeVenueSlug,
    })
    .returning({ id: schema.venues.id });
  if (!plusVenue || !freeVenue) throw new Error("venue insert returned no row");

  ctx = {
    plusOrgId: plusOrg.id,
    freeOrgId: freeOrg.id,
    plusVenueSlug,
    freeVenueSlug,
    plusVenueId: plusVenue.id,
    freeVenueId: freeVenue.id,
  };
});

afterAll(async () => {
  process.env["RESEND_INBOUND_SECRET"] = ORIGINAL_INBOUND_SECRET;
  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.plusOrgId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.freeOrgId));
  }
  await pool.end();
});

describe("POST /api/webhooks/resend-inbound — happy path", () => {
  it("creates an encrypted enquiry row + audit entry for a Plus venue", async () => {
    const body = fixturePayload({
      to: `${ctx.plusVenueSlug}@enquiries.tablekit.uk`,
      from: "Jane@Example.com",
      subject: "Booking enquiry",
      text: "Hi — table for 4 next Saturday evening, please. Birthday celebration.",
    });
    const headers = signPayload(body, TEST_SECRET_RAW);
    const res = await POST(
      makeRequest(body, {
        "svix-id": headers.svixId,
        "svix-timestamp": headers.svixTimestamp,
        "svix-signature": headers.svixSignature,
      }) as never,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; enquiryId?: string };
    expect(json.ok).toBe(true);
    expect(json.enquiryId).toBeDefined();

    const [row] = await db
      .select()
      .from(schema.enquiries)
      .where(eq(schema.enquiries.id, json.enquiryId!));
    expect(row?.organisationId).toBe(ctx.plusOrgId);
    expect(row?.venueId).toBe(ctx.plusVenueId);
    expect(row?.status).toBe("received");
    expect(row?.fromEmailHash).toBe(hashForLookup("jane@example.com", "email"));

    // Cipher fields round-trip under the org's DEK.
    const [from, subject, bodyText] = await Promise.all([
      decryptPii(ctx.plusOrgId, row!.fromEmailCipher as Ciphertext),
      decryptPii(ctx.plusOrgId, row!.subjectCipher as Ciphertext),
      decryptPii(ctx.plusOrgId, row!.bodyCipher as Ciphertext),
    ]);
    expect(from).toBe("jane@example.com");
    expect(subject).toBe("Booking enquiry");
    expect(bodyText).toContain("table for 4");

    // Audit entry exists, and metadata carries NO PII (no email, no
    // subject, no body content — just internal ids + a size hint).
    const [auditRow] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, row!.id));
    expect(auditRow?.action).toBe("enquiry.received");
    const meta = auditRow?.metadata as Record<string, unknown>;
    expect(meta["venueId"]).toBe(ctx.plusVenueId);
    // bodySize is bucketed (small/medium/large) — not the raw char
    // count — so audit entries can't fingerprint retries.
    expect(meta["bodySize"]).toMatch(/^(small|medium|large)$/);
    expect(JSON.stringify(meta)).not.toContain("jane");
    expect(JSON.stringify(meta)).not.toContain("Booking enquiry");
    expect(JSON.stringify(meta)).not.toContain("Birthday");
  });

  it("is idempotent on svix-id (Resend retries land as duplicates)", async () => {
    const body = fixturePayload({
      to: `${ctx.plusVenueSlug}@enquiries.tablekit.uk`,
      from: "joe@example.com",
      subject: "Idempotency probe",
      text: "Same payload twice.",
    });
    // Pin svix-id explicitly — same id on both POSTs is what
    // exercises the dedup path.
    const fixedId = `msg_${run}_idem`;
    const headers = signPayload(body, TEST_SECRET_RAW, fixedId);
    const reqHeaders = {
      "svix-id": headers.svixId,
      "svix-timestamp": headers.svixTimestamp,
      "svix-signature": headers.svixSignature,
    };

    const first = await POST(makeRequest(body, reqHeaders) as never);
    const firstJson = (await first.json()) as { ok: boolean; enquiryId?: string };
    expect(firstJson.enquiryId).toBeDefined();

    const second = await POST(makeRequest(body, reqHeaders) as never);
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { ok: boolean; ignored?: string };
    expect(secondJson.ignored).toBe("duplicate");

    // Only one enquiry row created across the two POSTs.
    const rows = await db
      .select({ id: schema.enquiries.id })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.fromEmailHash, hashForLookup("joe@example.com", "email")));
    expect(rows).toHaveLength(1);
  });

  it("drops HTML-only inbound (tracking-pixel hygiene)", async () => {
    // Hand-build a payload with no `text` field — only `html`.
    const body = JSON.stringify({
      type: "inbound.email.received",
      data: {
        from: { email: "kit@example.com" },
        to: [{ email: `${ctx.plusVenueSlug}@enquiries.tablekit.uk` }],
        subject: "HTML only",
        html: "<p>tracking pixel here</p>",
      },
    });
    const headers = signPayload(body, TEST_SECRET_RAW);
    const res = await POST(
      makeRequest(body, {
        "svix-id": headers.svixId,
        "svix-timestamp": headers.svixTimestamp,
        "svix-signature": headers.svixSignature,
      }) as never,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ignored?: string };
    expect(json.ignored).toBe("no-text");

    // No row created.
    const rows = await db
      .select({ id: schema.enquiries.id })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.fromEmailHash, hashForLookup("kit@example.com", "email")));
    expect(rows).toHaveLength(0);
  });

  it("rejects RFC-5321 quoted-locals as bad slugs", async () => {
    const body = fixturePayload({
      // Quoted-local that lastIndexOf("@") would otherwise tolerate.
      to: `"a@b"@enquiries.tablekit.uk`,
      from: "guest@example.com",
      subject: "Probe",
      text: "...",
    });
    const headers = signPayload(body, TEST_SECRET_RAW);
    const res = await POST(
      makeRequest(body, {
        "svix-id": headers.svixId,
        "svix-timestamp": headers.svixTimestamp,
        "svix-signature": headers.svixSignature,
      }) as never,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ignored?: string };
    expect(json.ignored).toBe("wrong-domain-or-bad-slug");
  });
});

describe("POST /api/webhooks/resend-inbound — drop paths (200 OK)", () => {
  it("drops a non-Plus org with 'not-entitled'", async () => {
    const body = fixturePayload({
      to: `${ctx.freeVenueSlug}@enquiries.tablekit.uk`,
      from: "guest@example.com",
      subject: "Hi",
      text: "...",
    });
    const headers = signPayload(body, TEST_SECRET_RAW);
    const res = await POST(
      makeRequest(body, {
        "svix-id": headers.svixId,
        "svix-timestamp": headers.svixTimestamp,
        "svix-signature": headers.svixSignature,
      }) as never,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; ignored?: string };
    expect(json.ignored).toBe("not-entitled");

    // No enquiry row created.
    const rows = await db
      .select({ id: schema.enquiries.id })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.organisationId, ctx.freeOrgId));
    expect(rows).toHaveLength(0);

    // But an enquiry.rejected audit entry IS written so the operator
    // can see the inbound was acknowledged + dropped.
    const [auditRow] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.organisationId, ctx.freeOrgId));
    expect(auditRow?.action).toBe("enquiry.rejected");
  });

  it("drops an unknown slug with 'unknown-venue'", async () => {
    const body = fixturePayload({
      to: `nobody-${run}@enquiries.tablekit.uk`,
      from: "guest@example.com",
      subject: "Hi",
      text: "...",
    });
    const headers = signPayload(body, TEST_SECRET_RAW);
    const res = await POST(
      makeRequest(body, {
        "svix-id": headers.svixId,
        "svix-timestamp": headers.svixTimestamp,
        "svix-signature": headers.svixSignature,
      }) as never,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ignored?: string };
    expect(json.ignored).toBe("unknown-venue");
  });

  it("drops a wrong-domain recipient with 'wrong-domain'", async () => {
    const body = fixturePayload({
      to: `${ctx.plusVenueSlug}@some-other.example.com`,
      from: "guest@example.com",
      subject: "Hi",
      text: "...",
    });
    const headers = signPayload(body, TEST_SECRET_RAW);
    const res = await POST(
      makeRequest(body, {
        "svix-id": headers.svixId,
        "svix-timestamp": headers.svixTimestamp,
        "svix-signature": headers.svixSignature,
      }) as never,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ignored?: string };
    expect(json.ignored).toBe("wrong-domain-or-bad-slug");
  });
});

describe("POST /api/webhooks/resend-inbound — auth failure paths (4xx)", () => {
  it("returns 400 when the signature is invalid", async () => {
    const body = fixturePayload({
      to: `${ctx.plusVenueSlug}@enquiries.tablekit.uk`,
      from: "guest@example.com",
      subject: "Hi",
      text: "...",
    });
    // Sign with a different secret — should fail verification.
    const wrongSecret = randomBytes(32);
    const headers = signPayload(body, wrongSecret);
    const res = await POST(
      makeRequest(body, {
        "svix-id": headers.svixId,
        "svix-timestamp": headers.svixTimestamp,
        "svix-signature": headers.svixSignature,
      }) as never,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("bad-signature");
  });

  it("returns 400 when Svix headers are missing entirely", async () => {
    const body = fixturePayload({
      to: `${ctx.plusVenueSlug}@enquiries.tablekit.uk`,
      from: "guest@example.com",
      subject: "Hi",
      text: "...",
    });
    const res = await POST(makeRequest(body, {}) as never);
    expect(res.status).toBe(400);
  });
});
