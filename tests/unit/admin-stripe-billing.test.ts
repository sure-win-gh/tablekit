import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so vi.mock can reference them — vitest hoists mock factories
// above all imports.
const { mockStripe, mockStripeEnabled } = vi.hoisted(() => ({
  mockStripe: vi.fn(),
  mockStripeEnabled: vi.fn(),
}));

vi.mock("@/lib/stripe/client", () => ({
  stripe: mockStripe,
  stripeEnabled: mockStripeEnabled,
}));

import { __resetMrrCache, getMrrSnapshot } from "@/lib/server/admin/dashboard/stripe-billing";

describe("getMrrSnapshot — degraded paths", () => {
  beforeEach(() => {
    __resetMrrCache();
    vi.clearAllMocks();
  });

  it("degraded when Stripe is not configured; never calls stripe()", async () => {
    mockStripeEnabled.mockReturnValue(false);

    const snap = await getMrrSnapshot();

    expect(snap.degraded).toBe(true);
    expect(snap.reason).toBe("stripe_not_configured");
    expect(snap.mrrMinor).toBe(0);
    expect(snap.activeSubs).toBe(0);
    expect(mockStripe).not.toHaveBeenCalled();
  });

  it("degraded when Stripe API throws; never throws to the caller", async () => {
    mockStripeEnabled.mockReturnValue(true);
    mockStripe.mockImplementation(() => {
      throw new Error("network blew up");
    });

    const snap = await getMrrSnapshot();

    expect(snap.degraded).toBe(true);
    expect(snap.reason).toBe("stripe_error");
    expect(snap.mrrMinor).toBe(0);
  });

  it("computes MRR from active subscriptions, grouped by lookup_key", async () => {
    mockStripeEnabled.mockReturnValue(true);
    mockStripe.mockReturnValue({
      subscriptions: {
        list: () => ({
          async *[Symbol.asyncIterator]() {
            // £19/month × 1
            yield {
              items: {
                data: [
                  {
                    quantity: 1,
                    price: {
                      unit_amount: 1900,
                      recurring: { interval: "month", interval_count: 1 },
                      lookup_key: "core",
                      nickname: null,
                    },
                  },
                ],
              },
            };
            // £390/year × 1 → ≈ £32.50/month (= 39000/12 = 3250 minor)
            yield {
              items: {
                data: [
                  {
                    quantity: 1,
                    price: {
                      unit_amount: 39000,
                      recurring: { interval: "year", interval_count: 1 },
                      lookup_key: "plus_yearly",
                      nickname: null,
                    },
                  },
                ],
              },
            };
          },
        }),
      },
    });

    const snap = await getMrrSnapshot();

    expect(snap.degraded).toBe(false);
    expect(snap.activeSubs).toBe(2);
    expect(snap.byTier["core"]).toBe(1900);
    expect(snap.byTier["plus_yearly"]).toBe(3250);
    expect(snap.mrrMinor).toBe(1900 + 3250);
  });
});
