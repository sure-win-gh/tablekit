// Operator AI usage summary (lib/billing/ai-usage-summary.ts).
//
// Shapes the dashboard readout: current-period sums, derived cost,
// budget position, and the queue-resume date (first of next period).

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getAiUsageSummary } from "@/lib/billing/ai-usage-summary";
import { recordAiUsage } from "@/lib/billing/ai-usage";
import * as schema from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);
const JUNE = new Date("2026-06-10T12:00:00Z");

let orgId: string;
let venueId: string;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `AIS ${run}`, slug: `ai-summary-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  orgId = org!.id;
  const [venue] = await db
    .insert(schema.venues)
    .values({ organisationId: orgId, name: "V", venueType: "cafe", timezone: "Europe/London" })
    .returning({ id: schema.venues.id });
  venueId = venue!.id;
});

afterAll(async () => {
  await db.delete(schema.organisations).where(eq(schema.organisations.id, orgId));
  await pool.end();
});

describe("getAiUsageSummary", () => {
  it("empty month: zero usage, under budget, resume date is 1st of next period", async () => {
    const s = await getAiUsageSummary(db, orgId, "plus", JUNE);
    expect(s).toMatchObject({
      period: "2026-06",
      callCount: 0,
      estCostPence: 0,
      overBudget: false,
    });
    expect(s.budgetPence).toBeGreaterThan(0);
    expect(s.resumesAt.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("sums usage and reports over-budget at the cap", async () => {
    // 10M input tokens ≈ 800p — over the Plus budget.
    await recordAiUsage({
      organisationId: orgId,
      venueId,
      usage: { inputTokens: 10_000_000, outputTokens: 0 },
      now: JUNE,
    });
    const s = await getAiUsageSummary(db, orgId, "plus", JUNE);
    expect(s.callCount).toBe(1);
    expect(s.inputTokens).toBe(10_000_000);
    expect(s.estCostPence).toBeGreaterThan(s.budgetPence);
    expect(s.overBudget).toBe(true);
  });

  it("plans without an AI budget are never flagged over-budget", async () => {
    const s = await getAiUsageSummary(db, orgId, "free", JUNE);
    expect(s.budgetPence).toBe(0);
    expect(s.overBudget).toBe(false);
  });

  it("December rolls the resume date into January", async () => {
    const s = await getAiUsageSummary(db, orgId, "plus", new Date("2026-12-15T00:00:00Z"));
    expect(s.period).toBe("2026-12");
    expect(s.resumesAt.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
