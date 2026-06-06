// Integration test for the prepaid gate at the campaign boundary (PR-2).
//
// Proves enqueueCampaign reserves credit before fanning out: an SMS
// campaign over the balance is blocked (nothing queued, no reservation),
// one within balance reserves + queues, and reconcileCampaign refunds the
// difference between reserved and actually-sent once the campaign drains.

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { getBalance, reconcileCampaign } from "@/lib/billing/credit";
import { enqueueCampaign } from "@/lib/campaigns/enqueue";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const NOW = new Date();
const run = Date.now().toString(36);
// Two SMS-consented guests → estimate 2 × 4p = 8p (CHANNEL_COST_PENCE.sms).
const SMS_PENCE = 4;
let orgId: string;
let venueId: string;

async function setBalance(pence: number) {
  await db
    .update(schema.organisations)
    .set({ creditBalancePence: pence })
    .where(eq(schema.organisations.id, orgId));
}

async function mkCampaign(): Promise<string> {
  const [c] = await db
    .insert(schema.campaigns)
    .values({
      organisationId: orgId, // overwritten by enforce trigger
      venueId,
      name: "Promo",
      channel: "sms",
      segment: "all",
      status: "draft",
      body: "Hi {{guestFirstName}}",
    })
    .returning({ id: schema.campaigns.id });
  return c!.id;
}

async function sendCount(campaignId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.campaignSends.id })
    .from(schema.campaignSends)
    .where(eq(schema.campaignSends.campaignId, campaignId));
  return rows.length;
}

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `CC ${run}`, slug: `cc-${run}` })
    .returning({ id: schema.organisations.id });
  orgId = org!.id;
  const [venue] = await db
    .insert(schema.venues)
    .values({ organisationId: orgId, name: "V", venueType: "cafe" })
    .returning({ id: schema.venues.id });
  venueId = venue!.id;

  // Two SMS-consented, reachable guests.
  for (let i = 0; i < 2; i++) {
    await db.insert(schema.guests).values({
      organisationId: orgId,
      firstName: "G",
      lastNameCipher: "c",
      emailCipher: "c",
      phoneCipher: "c",
      emailHash: `cc_${run}_${i}`,
      marketingConsentSmsAt: NOW,
    });
  }
});

afterAll(async () => {
  await db.delete(schema.organisations).where(eq(schema.organisations.id, orgId));
  await pool.end();
});

describe("enqueueCampaign prepaid gate", () => {
  it("blocks an SMS campaign the balance can't cover — nothing queued, no reservation", async () => {
    await setBalance(SMS_PENCE); // 4p < 8p estimate
    const campaignId = await mkCampaign();

    const r = await enqueueCampaign(campaignId, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "insufficient-credit") {
      expect(r.requiredPence).toBe(8);
      expect(r.balancePence).toBe(4);
    } else {
      throw new Error(`expected insufficient-credit, got ${JSON.stringify(r)}`);
    }

    expect(await sendCount(campaignId)).toBe(0);
    expect(await getBalance(db, orgId)).toBe(4); // untouched
    const [status] = await db
      .select({ s: schema.campaigns.status })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(status!.s).toBe("draft"); // stays a draft, not 'sending'
  });

  it("reserves + queues when the balance covers it, then refunds the unsent remainder", async () => {
    await setBalance(100);
    const campaignId = await mkCampaign();

    const r = await enqueueCampaign(campaignId, { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.queued).toBe(2);
    expect(await getBalance(db, orgId)).toBe(92); // 100 − 8 reserved
    expect(await sendCount(campaignId)).toBe(2);

    // Simulate one send succeeding, one not (skipped/failed) before drain.
    const [firstSend] = await db
      .select({ id: schema.campaignSends.id })
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.campaignId, campaignId))
      .limit(1);
    await db
      .update(schema.campaignSends)
      .set({ status: "sent" })
      .where(eq(schema.campaignSends.id, firstSend!.id));

    await reconcileCampaign(campaignId);
    // Reserved 8p, actually sent 1 × 4p = 4p → refund 4p.
    expect(await getBalance(db, orgId)).toBe(96);

    // Double-charge invariant: marketing is prepaid via credit, so campaign
    // sends must NEVER also write the message_usage meter (transactional-only).
    const usageRows = await db
      .select({ id: schema.messageUsage.id })
      .from(schema.messageUsage)
      .where(eq(schema.messageUsage.organisationId, orgId));
    expect(usageRows).toHaveLength(0);

    // Idempotent: a second reconcile (the finaliser runs every drain) refunds nothing more.
    await reconcileCampaign(campaignId);
    expect(await getBalance(db, orgId)).toBe(96);
    const refunds = await db
      .select({ id: schema.billingCreditLedger.id })
      .from(schema.billingCreditLedger)
      .where(
        and(
          eq(schema.billingCreditLedger.reason, "campaign_refund"),
          eq(schema.billingCreditLedger.ref, campaignId),
        ),
      );
    expect(refunds).toHaveLength(1);
  });
});
