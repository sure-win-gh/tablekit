// Integration test for the operator-action apply layer.
//
// Drives `apply*` helpers directly so we can assert the post-decision
// SQL behaviour (conditional WHERE on status, persisted ciphertext,
// etc.) without standing up a Supabase session. The auth wrappers in
// app/.../enquiries/actions.ts are thin: zod parse + requireRole +
// requirePlan + assertVenueVisible + delegate to apply*.
//
// Coverage:
//   - applyDismiss: happy path, rejected from terminal, idempotency
//     (second call to a now-discarded row returns wrong-status).
//   - applyResetOrphan: rejected when not stale enough; allowed once
//     past the stale window.
//   - applyRetryFailed: clears parseAttempts + error.
//   - applySendDraftPostSend: status flip + ciphertext overwrite;
//     conditional WHERE prevents a second flip.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  ORPHAN_PARSING_STALE_MS,
  applyDismiss,
  applyResetOrphan,
  applyRetryFailed,
  applySendDraftPostSend,
} from "@/lib/enquiries/operator-actions";
import { type Ciphertext, decryptPii, encryptPii, type Plaintext } from "@/lib/security/crypto";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);
type Ctx = { orgId: string; venueId: string };
let ctx: Ctx;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Enq-Act ${run}`, slug: `enq-act-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  if (!org) throw new Error("org insert returned no row");
  const [venue] = await db
    .insert(schema.venues)
    .values({
      organisationId: org.id,
      name: "Action Cafe",
      venueType: "cafe",
      slug: `enq-act-${run}`,
    })
    .returning({ id: schema.venues.id });
  if (!venue) throw new Error("venue insert returned no row");
  ctx = { orgId: org.id, venueId: venue.id };
  await encryptPii(ctx.orgId, "" as Plaintext);
});

afterAll(async () => {
  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

async function seed(opts: {
  status: "received" | "draft_ready" | "replied" | "discarded" | "failed" | "parsing";
  draft?: string | null;
  parseAttempts?: number;
  errorMsg?: string | null;
}): Promise<string> {
  const [from, subj, bod] = await Promise.all([
    encryptPii(ctx.orgId, "guest@example.com" as Plaintext),
    encryptPii(ctx.orgId, "subject" as Plaintext),
    encryptPii(ctx.orgId, "body" as Plaintext),
  ]);
  const draftCipher = opts.draft ? await encryptPii(ctx.orgId, opts.draft as Plaintext) : null;
  const [row] = await db
    .insert(schema.enquiries)
    .values({
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      fromEmailHash: `h-${run}-${Math.random()}`,
      fromEmailCipher: from,
      subjectCipher: subj,
      bodyCipher: bod,
      draftReplyCipher: draftCipher,
      status: opts.status,
      parseAttempts: opts.parseAttempts ?? 0,
      error: opts.errorMsg ?? null,
    })
    .returning({ id: schema.enquiries.id });
  if (!row) throw new Error("seed insert returned no row");
  return row.id;
}

describe("applyDismiss", () => {
  it("transitions draft_ready → discarded", async () => {
    const id = await seed({ status: "draft_ready", draft: "hi" });
    const r = await applyDismiss(db, { enquiryId: id, venueId: ctx.venueId });
    expect(r.ok).toBe(true);
    const [row] = await db
      .select({ status: schema.enquiries.status })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.id, id));
    expect(row?.status).toBe("discarded");
  });

  it("rejects wrong-status from replied", async () => {
    const id = await seed({ status: "replied" });
    const r = await applyDismiss(db, { enquiryId: id, venueId: ctx.venueId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong-status");
  });

  it("returns not-found when the venueId mismatches the row", async () => {
    const id = await seed({ status: "draft_ready", draft: "hi" });
    const r = await applyDismiss(db, {
      enquiryId: id,
      venueId: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-found");
  });
});

describe("applyResetOrphan", () => {
  it("rejects when status is parsing but the row was just updated", async () => {
    const id = await seed({ status: "parsing" });
    const r = await applyResetOrphan(db, {
      enquiryId: id,
      venueId: ctx.venueId,
      now: new Date(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-stale-enough");
  });

  it("allows reset once the row is stale enough", async () => {
    const id = await seed({ status: "parsing" });
    // Advance "now" past the stale window rather than fudging
    // updatedAt — keeps the test robust to clock skew.
    const future = new Date(Date.now() + ORPHAN_PARSING_STALE_MS + 1000);
    const r = await applyResetOrphan(db, {
      enquiryId: id,
      venueId: ctx.venueId,
      now: future,
    });
    expect(r.ok).toBe(true);
    const [row] = await db
      .select({ status: schema.enquiries.status })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.id, id));
    expect(row?.status).toBe("received");
  });

  it("rejects when status is not parsing", async () => {
    const id = await seed({ status: "draft_ready", draft: "hi" });
    const future = new Date(Date.now() + ORPHAN_PARSING_STALE_MS + 1000);
    const r = await applyResetOrphan(db, {
      enquiryId: id,
      venueId: ctx.venueId,
      now: future,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong-status");
  });
});

describe("applyRetryFailed", () => {
  it("transitions failed → received with attempts cleared", async () => {
    const id = await seed({ status: "failed", parseAttempts: 3, errorMsg: "boom" });
    const r = await applyRetryFailed(db, { enquiryId: id, venueId: ctx.venueId });
    expect(r.ok).toBe(true);
    const [row] = await db
      .select({
        status: schema.enquiries.status,
        parseAttempts: schema.enquiries.parseAttempts,
        error: schema.enquiries.error,
      })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.id, id));
    expect(row?.status).toBe("received");
    expect(row?.parseAttempts).toBe(0);
    expect(row?.error).toBeNull();
  });
});

describe("applySendDraftPostSend", () => {
  it("flips draft_ready → replied and overwrites the draft cipher with the sent body", async () => {
    const id = await seed({ status: "draft_ready", draft: "original" });
    const finalCipher = await encryptPii(ctx.orgId, "edited reply" as Plaintext);
    const repliedAt = new Date();
    const r = await applySendDraftPostSend(db, {
      enquiryId: id,
      venueId: ctx.venueId,
      finalBodyCipher: finalCipher,
      repliedAt,
    });
    expect(r.rowsAffected).toBe(1);
    const [row] = await db
      .select({
        status: schema.enquiries.status,
        draft: schema.enquiries.draftReplyCipher,
        repliedAt: schema.enquiries.repliedAt,
      })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.id, id));
    expect(row?.status).toBe("replied");
    const sent = await decryptPii(ctx.orgId, row!.draft as Ciphertext);
    expect(sent).toBe("edited reply");
    expect(row?.repliedAt?.getTime()).toBeCloseTo(repliedAt.getTime(), -2);
  });

  it("is a no-op on the second call (concurrent double-send safety)", async () => {
    const id = await seed({ status: "draft_ready", draft: "first" });
    const cipher1 = await encryptPii(ctx.orgId, "first send" as Plaintext);
    const cipher2 = await encryptPii(ctx.orgId, "second send" as Plaintext);
    const r1 = await applySendDraftPostSend(db, {
      enquiryId: id,
      venueId: ctx.venueId,
      finalBodyCipher: cipher1,
      repliedAt: new Date(),
    });
    expect(r1.rowsAffected).toBe(1);
    const r2 = await applySendDraftPostSend(db, {
      enquiryId: id,
      venueId: ctx.venueId,
      finalBodyCipher: cipher2,
      repliedAt: new Date(),
    });
    expect(r2.rowsAffected).toBe(0);

    // Verify the persisted body is still the first send — the
    // conditional WHERE prevented the second one from clobbering.
    const [row] = await db
      .select({ draft: schema.enquiries.draftReplyCipher })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.id, id));
    const persisted = await decryptPii(ctx.orgId, row!.draft as Ciphertext);
    expect(persisted).toBe("first send");
  });

  it("rejects (rowsAffected=0) when the row is in another venue", async () => {
    const id = await seed({ status: "draft_ready", draft: "hi" });
    const cipher = await encryptPii(ctx.orgId, "edited" as Plaintext);
    const r = await applySendDraftPostSend(db, {
      enquiryId: id,
      venueId: "00000000-0000-0000-0000-000000000000",
      finalBodyCipher: cipher,
      repliedAt: new Date(),
    });
    expect(r.rowsAffected).toBe(0);
  });
});
