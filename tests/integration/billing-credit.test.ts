// Integration tests for the prepaid credit primitives (PR-2).
//
// applyEntry idempotency, the reserve gate (debit when covered, throw when
// short, no-op on retry), and race-safety: two campaigns reserving at once
// against a balance that covers only one — exactly one wins, never both.

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  InsufficientCreditError,
  applyEntry,
  getBalance,
  reserveForCampaign,
} from "@/lib/billing/credit";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const run = Date.now().toString(36);
let orgId: string;

async function setBalance(pence: number) {
  await db
    .update(schema.organisations)
    .set({ creditBalancePence: pence })
    .where(eq(schema.organisations.id, orgId));
}
async function ledgerCount(reason: string, ref: string): Promise<number> {
  const [row] = await db
    .select({ n: schema.billingCreditLedger.id })
    .from(schema.billingCreditLedger)
    .where(
      and(eq(schema.billingCreditLedger.reason, reason), eq(schema.billingCreditLedger.ref, ref)),
    );
  return row ? 1 : 0;
}

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `CREDIT ${run}`, slug: `credit-${run}` })
    .returning({ id: schema.organisations.id });
  orgId = org!.id;
});

afterAll(async () => {
  await db.delete(schema.organisations).where(eq(schema.organisations.id, orgId));
  await pool.end();
});

describe("applyEntry", () => {
  it("credits the balance once and is idempotent on (reason, ref)", async () => {
    await setBalance(0);
    const ref = `pi_topup_${run}`;
    const first = await applyEntry({
      organisationId: orgId,
      deltaPence: 1000,
      reason: "topup",
      ref,
    });
    expect(first).toEqual({ applied: true, balancePence: 1000 });

    // Replay the same Stripe ref → no-op, balance unchanged.
    const second = await applyEntry({
      organisationId: orgId,
      deltaPence: 1000,
      reason: "topup",
      ref,
    });
    expect(second).toEqual({ applied: false, balancePence: 1000 });
    expect(await getBalance(db, orgId)).toBe(1000);
    expect(await ledgerCount("topup", ref)).toBe(1);
  });
});

describe("reserveForCampaign", () => {
  it("debits when the balance covers the estimate", async () => {
    await setBalance(1000);
    await reserveForCampaign(orgId, `camp_a_${run}`, 600);
    expect(await getBalance(db, orgId)).toBe(400);
  });

  it("throws InsufficientCreditError when short and leaves the balance intact", async () => {
    await setBalance(400);
    await expect(reserveForCampaign(orgId, `camp_b_${run}`, 600)).rejects.toBeInstanceOf(
      InsufficientCreditError,
    );
    expect(await getBalance(db, orgId)).toBe(400);
    expect(await ledgerCount("campaign_reserve", `camp_b_${run}`)).toBe(0);
  });

  it("is a no-op on a retried reserve for the same campaign", async () => {
    await setBalance(1000);
    const camp = `camp_retry_${run}`;
    await reserveForCampaign(orgId, camp, 700);
    await reserveForCampaign(orgId, camp, 700); // retry — must not debit twice
    expect(await getBalance(db, orgId)).toBe(300);
  });

  it("a zero estimate (email campaign) never touches the balance", async () => {
    await setBalance(50);
    await reserveForCampaign(orgId, `camp_email_${run}`, 0);
    expect(await getBalance(db, orgId)).toBe(50);
    expect(await ledgerCount("campaign_reserve", `camp_email_${run}`)).toBe(0);
  });

  it("is race-safe: two concurrent reserves against a one-fits balance — exactly one wins", async () => {
    await setBalance(500);
    const results = await Promise.allSettled([
      reserveForCampaign(orgId, `camp_r1_${run}`, 500),
      reserveForCampaign(orgId, `camp_r2_${run}`, 500),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    expect(await getBalance(db, orgId)).toBe(0); // never went negative
  });
});
