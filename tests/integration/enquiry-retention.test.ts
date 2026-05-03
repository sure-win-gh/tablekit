// Integration test for the 90-day retention sweeper.
//
// Drives `sweepExpiredEnquiries` directly with a synthetic `now` so
// we can place rows on either side of the cutoff without sleeping or
// fudging system time. Coverage:
//   - rows with received_at older than 90d are hard-deleted
//   - rows at 89d 23h are NOT deleted (boundary)
//   - all statuses are eligible (received, draft_ready, replied,
//     discarded, failed) — clock is received_at, not status-based
//   - batchSize honoured (multi-tick drain)
//   - empty backlog returns {deleted: 0} without error

import { eq, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { ENQUIRY_RETENTION_DAYS, sweepExpiredEnquiries } from "@/lib/enquiries/retention";
import { encryptPii, type Plaintext } from "@/lib/security/crypto";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);
type Ctx = { orgId: string; venueId: string };
let ctx: Ctx;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Enq-Ret ${run}`, slug: `enq-ret-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  if (!org) throw new Error("org insert returned no row");
  const [venue] = await db
    .insert(schema.venues)
    .values({
      organisationId: org.id,
      name: "Retention Cafe",
      venueType: "cafe",
      slug: `enq-ret-${run}`,
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
  receivedAt: Date;
  status?: "received" | "draft_ready" | "replied" | "discarded" | "failed";
}): Promise<string> {
  const [from, subj, bod] = await Promise.all([
    encryptPii(ctx.orgId, "guest@example.com" as Plaintext),
    encryptPii(ctx.orgId, "subject" as Plaintext),
    encryptPii(ctx.orgId, "body" as Plaintext),
  ]);
  const [row] = await db
    .insert(schema.enquiries)
    .values({
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      fromEmailHash: `h-${run}-${Math.random()}`,
      fromEmailCipher: from,
      subjectCipher: subj,
      bodyCipher: bod,
      status: opts.status ?? "received",
      receivedAt: opts.receivedAt,
    })
    .returning({ id: schema.enquiries.id });
  if (!row) throw new Error("seed insert returned no row");
  return row.id;
}

async function exists(id: string): Promise<boolean> {
  const [r] = await db
    .select({ id: schema.enquiries.id })
    .from(schema.enquiries)
    .where(eq(schema.enquiries.id, id));
  return Boolean(r);
}

describe("sweepExpiredEnquiries — boundary", () => {
  it("deletes a row received 91 days ago, leaves a row at 89 days", async () => {
    const now = new Date("2026-08-01T04:15:00Z");
    const oldId = await seed({
      receivedAt: new Date(now.getTime() - 91 * DAY_MS),
    });
    const youngId = await seed({
      receivedAt: new Date(now.getTime() - 89 * DAY_MS),
    });

    const result = await sweepExpiredEnquiries({ now });
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    expect(await exists(oldId)).toBe(false);
    expect(await exists(youngId)).toBe(true);
  });

  it("treats the cutoff as strictly less-than (90d 0s row survives)", async () => {
    const now = new Date("2026-08-02T04:15:00Z");
    // Exactly at the cutoff. lt() means rows at the cutoff stay.
    const atCutoff = await seed({
      receivedAt: new Date(now.getTime() - ENQUIRY_RETENTION_DAYS * DAY_MS),
    });
    await sweepExpiredEnquiries({ now });
    expect(await exists(atCutoff)).toBe(true);
  });
});

describe("sweepExpiredEnquiries — status agnostic", () => {
  it("deletes expired rows regardless of status", async () => {
    const now = new Date("2026-08-03T04:15:00Z");
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const ids = await Promise.all([
      seed({ receivedAt: old, status: "received" }),
      seed({ receivedAt: old, status: "draft_ready" }),
      seed({ receivedAt: old, status: "replied" }),
      seed({ receivedAt: old, status: "discarded" }),
      seed({ receivedAt: old, status: "failed" }),
    ]);

    await sweepExpiredEnquiries({ now });

    const remaining = await db
      .select({ id: schema.enquiries.id })
      .from(schema.enquiries)
      .where(inArray(schema.enquiries.id, ids));
    expect(remaining).toEqual([]);
  });
});

describe("sweepExpiredEnquiries — batching", () => {
  it("respects batchSize and drains over multiple calls", async () => {
    const now = new Date("2026-08-04T04:15:00Z");
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const ids = await Promise.all([
      seed({ receivedAt: old }),
      seed({ receivedAt: old }),
      seed({ receivedAt: old }),
      seed({ receivedAt: old }),
      seed({ receivedAt: old }),
    ]);

    const r1 = await sweepExpiredEnquiries({ now, batchSize: 2 });
    expect(r1.deleted).toBe(2);

    const r2 = await sweepExpiredEnquiries({ now, batchSize: 2 });
    expect(r2.deleted).toBe(2);

    const r3 = await sweepExpiredEnquiries({ now, batchSize: 2 });
    expect(r3.deleted).toBe(1);

    const remaining = await db
      .select({ id: schema.enquiries.id })
      .from(schema.enquiries)
      .where(inArray(schema.enquiries.id, ids));
    expect(remaining).toEqual([]);
  });

  it("returns deleted: 0 on an empty backlog", async () => {
    const now = new Date("2025-01-01T00:00:00Z"); // before any seeded row
    const r = await sweepExpiredEnquiries({ now });
    expect(r.deleted).toBe(0);
    expect(r.cutoff).toBe(new Date(now.getTime() - 90 * DAY_MS).toISOString());
  });
});
