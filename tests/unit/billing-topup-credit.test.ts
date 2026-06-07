// Unit coverage for creditTopupFromSession — credits the PRE-VAT amount
// (amount_subtotal), since prices are tax-exclusive and the VAT in
// amount_total goes to HMRC, not the messaging wallet.

import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRecordTopup } = vi.hoisted(() => ({ mockRecordTopup: vi.fn() }));
vi.mock("@/lib/billing/credit", () => ({ recordTopup: mockRecordTopup }));

import { creditTopupFromSession } from "@/lib/billing/topup";

function session(over: Partial<Stripe.Checkout.Session>): Stripe.Checkout.Session {
  return {
    id: "cs_test_1",
    metadata: { organisation_id: "org1" },
    amount_subtotal: 5000,
    amount_total: 6000,
    ...over,
  } as Stripe.Checkout.Session;
}

describe("creditTopupFromSession", () => {
  beforeEach(() => mockRecordTopup.mockReset());

  it("credits the pre-VAT amount_subtotal, not amount_total", async () => {
    await creditTopupFromSession(session({ amount_subtotal: 5000, amount_total: 6000 }));
    expect(mockRecordTopup).toHaveBeenCalledWith("org1", 5000, "cs_test_1");
  });

  it("skips when amount_subtotal is null/non-positive", async () => {
    await creditTopupFromSession(session({ amount_subtotal: null }));
    await creditTopupFromSession(session({ amount_subtotal: 0 }));
    expect(mockRecordTopup).not.toHaveBeenCalled();
  });

  it("skips when the org id is missing", async () => {
    await creditTopupFromSession(session({ metadata: {} }));
    expect(mockRecordTopup).not.toHaveBeenCalled();
  });
});
