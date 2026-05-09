// Integration tests for webhook delivery replay (PR6c).
// Coverage:
//   - replay creates a fresh `pending` row preserving event_type +
//     event_id + payload + subscription_id; original row stays
//     in its terminal state.
//   - cross-org replay refused (returns not-found shape).
//   - replay against revoked subscription refused.

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { dispatchEvent } from "@/lib/webhooks/dispatch";
import { replayDelivery } from "@/lib/webhooks/replay";
import { createSubscription, revokeSubscription } from "@/lib/webhooks/subscribe";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);
type Ctx = { orgAId: string; orgBId: string };
let ctx: Ctx;

beforeAll(async () => {
  const [a] = await db
    .insert(schema.organisations)
    .values({ name: `WHK-R-A ${run}`, slug: `whk-r-a-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [b] = await db
    .insert(schema.organisations)
    .values({ name: `WHK-R-B ${run}`, slug: `whk-r-b-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  ctx = { orgAId: a!.id, orgBId: b!.id };
});

afterAll(async () => {
  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

async function seedDelivery(args: { orgId: string; finalStatus?: "succeeded" | "failed" }) {
  const sub = await createSubscription({
    organisationId: args.orgId,
    createdByUserId: null as unknown as string,
    url: "https://example.com/replay",
    label: `replay-${Math.random()}`,
    events: ["booking.created"] as never,
  });
  const eventId = `replay-${run}-${Math.random()}`;
  await dispatchEvent({
    organisationId: args.orgId,
    eventType: "booking.created",
    eventId,
    payload: { booking_id: "bk-replay", marker: eventId },
  });
  // Each test in this file leaves subs active; dispatchEvent fans
  // out to all matching subs, producing multiple delivery rows with
  // the same eventId. Pin to OUR subscription so subsequent
  // assertions can't pick up a sibling sub's row.
  const [delivery] = await db
    .select({ id: schema.webhookDeliveries.id })
    .from(schema.webhookDeliveries)
    .where(
      and(
        eq(schema.webhookDeliveries.eventId, eventId),
        eq(schema.webhookDeliveries.subscriptionId, sub.id),
      ),
    )
    .limit(1);
  // Move the original to a terminal state so we can verify it stays
  // there post-replay.
  await db
    .update(schema.webhookDeliveries)
    .set({ status: args.finalStatus ?? "failed", lastStatus: 500, lastError: "http:500" })
    .where(eq(schema.webhookDeliveries.id, delivery!.id));
  return { subId: sub.id, deliveryId: delivery!.id, eventId };
}

describe("replayDelivery — happy path", () => {
  it("creates a fresh pending row preserving event + payload + subscription", async () => {
    const seeded = await seedDelivery({ orgId: ctx.orgAId });

    const r = await replayDelivery({ deliveryId: seeded.deliveryId, organisationId: ctx.orgAId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const [replay] = await db
      .select({
        status: schema.webhookDeliveries.status,
        attempts: schema.webhookDeliveries.attempts,
        subscriptionId: schema.webhookDeliveries.subscriptionId,
        eventType: schema.webhookDeliveries.eventType,
        eventId: schema.webhookDeliveries.eventId,
        payload: schema.webhookDeliveries.payload,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, r.replayDeliveryId));
    expect(replay?.status).toBe("pending");
    expect(replay?.attempts).toBe(0);
    expect(replay?.subscriptionId).toBe(seeded.subId);
    expect(replay?.eventType).toBe("booking.created");
    expect(replay?.eventId).toBe(seeded.eventId);
    expect((replay?.payload as { marker: string }).marker).toBe(seeded.eventId);

    // Original row UNCHANGED — replay must not erase the audit trail.
    const [original] = await db
      .select({ status: schema.webhookDeliveries.status })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, seeded.deliveryId));
    expect(original?.status).toBe("failed");
  });
});

describe("replayDelivery — refusals", () => {
  it("refuses cross-org replay (returns not-found)", async () => {
    const seeded = await seedDelivery({ orgId: ctx.orgAId });
    const r = await replayDelivery({ deliveryId: seeded.deliveryId, organisationId: ctx.orgBId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-found");
  });

  it("refuses replay when subscription is revoked", async () => {
    const seeded = await seedDelivery({ orgId: ctx.orgAId });
    const revoked = await revokeSubscription({
      subscriptionId: seeded.subId,
      organisationId: ctx.orgAId,
    });
    expect(revoked.revoked).toBe(true);
    // Sanity-check the actual DB state — the revoke should have
    // persisted both the timestamp and active=false.
    const [subAfter] = await db
      .select({
        active: schema.webhookSubscriptions.active,
        revokedAt: schema.webhookSubscriptions.revokedAt,
      })
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, seeded.subId));
    expect(subAfter?.active).toBe(false);
    expect(subAfter?.revokedAt).not.toBeNull();

    const r = await replayDelivery({ deliveryId: seeded.deliveryId, organisationId: ctx.orgAId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("subscription-revoked");
  });
});
