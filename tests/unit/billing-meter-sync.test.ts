// Unit coverage for the transactional usage → Stripe meter sync.
//
// Asserts the delta arithmetic (report only un-reported pence), the
// idempotent identifier (encodes the pre-advance watermark), skipping orgs
// with no platform customer, and per-row failure isolation — all with a
// faked adminDb + Stripe client so no DB/network is touched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreate, mockStripeEnabled, state } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockStripeEnabled: vi.fn(),
  state: {
    rows: [] as unknown[],
    updated: [] as { reportedPence: number }[],
    failUpdate: false,
  },
}));

vi.mock("@/lib/stripe/client", () => ({
  stripe: () => ({ billing: { meterEvents: { create: mockCreate } } }),
  stripeEnabled: mockStripeEnabled,
}));

vi.mock("@/lib/server/admin/db", () => {
  const db = {
    select: () => db,
    from: () => db,
    innerJoin: () => db,
    where: () => Promise.resolve(state.rows),
    update: () => ({
      set: (vals: { reportedPence: number }) => ({
        where: () => {
          if (state.failUpdate) return Promise.reject(new Error("update boom"));
          state.updated.push({ reportedPence: vals.reportedPence });
          return Promise.resolve();
        },
      }),
    }),
  };
  return { adminDb: () => db };
});

import { reportUsageDeltas } from "@/lib/billing/meter-sync";

const NOW = new Date("2026-06-15T12:00:00Z");
const PERIOD = "2026-06";

function row(over: Record<string, unknown>) {
  return {
    id: "row1",
    organisationId: "org1",
    channel: "sms",
    estCostPence: 40,
    reportedPence: 0,
    customerId: "cus_1",
    // Multi-region Phase 2: every row carries the org's billing entity.
    billingEntity: "uk",
    ...over,
  };
}

beforeEach(() => {
  state.rows = [];
  state.updated = [];
  state.failUpdate = false;
  mockCreate.mockReset();
  mockStripeEnabled.mockReturnValue(true);
  process.env["STRIPE_METER_USAGE_EVENT_NAME"] = "tablekit_usage";
});
afterEach(() => {
  delete process.env["STRIPE_METER_USAGE_EVENT_NAME"];
});

describe("reportUsageDeltas", () => {
  it("reports the un-reported delta in pence with an idempotent identifier", async () => {
    state.rows = [row({ estCostPence: 40, reportedPence: 16 })];
    const r = await reportUsageDeltas(NOW);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      event_name: "tablekit_usage",
      payload: { stripe_customer_id: "cus_1", value: "24" }, // 40 − 16
      identifier: `org1_${PERIOD}_sms_16`, // encodes the pre-advance watermark
    });
    expect(state.updated).toEqual([{ reportedPence: 40 }]);
    expect(r).toEqual({ reported: 1, skipped: 0, failed: 0 });
  });

  it("counts a row as failed if the watermark-advance write throws", async () => {
    state.rows = [row({})];
    state.failUpdate = true;
    const r = await reportUsageDeltas(NOW);
    // The meter event was sent, but advancing the watermark failed → failed,
    // and the watermark stays put (no spurious 'updated').
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(state.updated).toEqual([]);
    expect(r).toEqual({ reported: 0, skipped: 0, failed: 1 });
  });

  it("skips a row whose org has no platform customer (can't bill)", async () => {
    state.rows = [row({ customerId: null })];
    const r = await reportUsageDeltas(NOW);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(r).toEqual({ reported: 0, skipped: 1, failed: 0 });
  });

  it("isolates a per-row Stripe failure — the rest still report", async () => {
    state.rows = [
      row({ id: "a", organisationId: "orgA", customerId: "cus_a" }),
      row({ id: "b", organisationId: "orgB", customerId: "cus_b" }),
    ];
    mockCreate.mockRejectedValueOnce(new Error("stripe boom")).mockResolvedValueOnce({});
    const r = await reportUsageDeltas(NOW);
    expect(r).toEqual({ reported: 1, skipped: 0, failed: 1 });
  });

  it("no-ops when Stripe is disabled or the meter event name is unset", async () => {
    state.rows = [row({})];
    mockStripeEnabled.mockReturnValue(false);
    expect(await reportUsageDeltas(NOW)).toEqual({ reported: 0, skipped: 0, failed: 0 });
    expect(mockCreate).not.toHaveBeenCalled();

    mockStripeEnabled.mockReturnValue(true);
    delete process.env["STRIPE_METER_USAGE_EVENT_NAME"];
    expect(await reportUsageDeltas(NOW)).toEqual({ reported: 0, skipped: 0, failed: 0 });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
