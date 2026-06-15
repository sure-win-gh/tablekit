// Integration test for the race-safe webhook idempotency claim.
//
//   * a fresh event claims as "new";
//   * a re-claim of an UNPROCESSED event (prior crash) recovers, not skips —
//     so the order isn't lost when ingest fails after the claim commits;
//   * a re-claim of a PROCESSED event is a true duplicate.
//
// Also pins the effective Art. 9 gate: a connection with line_items_enabled
// but NO art9_basis_confirmed_at must surface lineItemsEnabled=false from the
// ingest context (line items can't be stored on the flag alone).

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { upsertPosConnection } from "@/lib/pos/connection";
import { loadIngestContextByConnectionId } from "@/lib/pos/ingest-context";
import { claimPosWebhookEvent, markPosWebhookProcessed } from "@/lib/pos/webhook-dedupe";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const run = Date.now().toString(36);

type Ctx = { orgId: string; venueId: string; connId: string; art9ConnId: string };
let ctx: Ctx;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `POS-DD ${run}`, slug: `pos-dd-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [venue] = await db
    .insert(schema.venues)
    .values({
      organisationId: org!.id,
      name: "V",
      venueType: "restaurant",
      timezone: "Europe/London",
    })
    .returning({ id: schema.venues.id });
  const connId = await upsertPosConnection({
    organisationId: org!.id,
    venueId: venue!.id,
    provider: "square",
    externalAccountId: `dd-${run}`,
  });
  // A generic connection with line items enabled but Art. 9 basis NOT confirmed.
  const art9ConnId = await upsertPosConnection({
    organisationId: org!.id,
    venueId: venue!.id,
    provider: "generic",
  });
  await db
    .update(schema.posConnections)
    .set({ lineItemsEnabled: true, art9BasisConfirmedAt: null })
    .where(eq(schema.posConnections.id, art9ConnId));

  ctx = { orgId: org!.id, venueId: venue!.id, connId, art9ConnId };
});

afterAll(async () => {
  if (ctx) await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  await pool.end();
});

describe("claimPosWebhookEvent — race-safe idempotency", () => {
  it("claims a fresh event as new, recovers an unprocessed re-claim, dupes a processed one", async () => {
    const evt = `evt-dd-${run}`;
    const first = await claimPosWebhookEvent({
      organisationId: ctx.orgId,
      connectionId: ctx.connId,
      provider: "square",
      externalEventId: evt,
    });
    expect(first.status).toBe("new");

    // Re-claim before marking processed → recover (simulates a crash between
    // claim and ingest). The order would be RE-INGESTED, not lost.
    const recover = await claimPosWebhookEvent({
      organisationId: ctx.orgId,
      connectionId: ctx.connId,
      provider: "square",
      externalEventId: evt,
    });
    expect(recover.status).toBe("recover");

    // Mark processed, then re-claim → true duplicate.
    if (recover.status === "recover") await markPosWebhookProcessed(recover.eventRowId);
    const dupe = await claimPosWebhookEvent({
      organisationId: ctx.orgId,
      connectionId: ctx.connId,
      provider: "square",
      externalEventId: evt,
    });
    expect(dupe.status).toBe("duplicate");
  });
});

describe("Art. 9 effective gate", () => {
  it("line items stay disabled when the basis is unconfirmed, even with the flag on", async () => {
    const ctxRow = await loadIngestContextByConnectionId(ctx.art9ConnId);
    expect(ctxRow?.lineItemsEnabled).toBe(false);
  });

  it("line items become enabled once the Art. 9 basis is confirmed", async () => {
    await db
      .update(schema.posConnections)
      .set({ art9BasisConfirmedAt: new Date() })
      .where(eq(schema.posConnections.id, ctx.art9ConnId));
    const ctxRow = await loadIngestContextByConnectionId(ctx.art9ConnId);
    expect(ctxRow?.lineItemsEnabled).toBe(true);
  });
});
