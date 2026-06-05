// Unit coverage for the checkout.session.completed handler routing.
//
// The dispatch registry holds ONE handler per event type, so this handler
// must: (a) handle subscription-mode sessions by retrieving the sub and
// delegating to syncFromSubscription, and (b) ignore payment-mode sessions
// (reserved for PR-2 top-ups) without touching Stripe or the sync path.

import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRetrieve, mockSync, mockTopup } = vi.hoisted(() => ({
  mockRetrieve: vi.fn(),
  mockSync: vi.fn(),
  mockTopup: vi.fn(),
}));

vi.mock("@/lib/stripe/client", () => ({
  stripe: () => ({ subscriptions: { retrieve: mockRetrieve } }),
}));
vi.mock("@/lib/billing/subscription", () => ({ syncFromSubscription: mockSync }));
vi.mock("@/lib/billing/topup", () => ({ creditTopupFromSession: mockTopup }));

import "@/lib/stripe/handlers/billing-checkout"; // registers the handler
import { getHandler } from "@/lib/stripe/webhook";

function sessionEvent(session: Partial<Stripe.Checkout.Session>): Stripe.Event {
  return { type: "checkout.session.completed", data: { object: session } } as Stripe.Event;
}

describe("checkout.session.completed handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retrieves the subscription and syncs it for subscription-mode sessions", async () => {
    const fakeSub = { id: "sub_123" } as Stripe.Subscription;
    mockRetrieve.mockResolvedValue(fakeSub);
    const handler = getHandler("checkout.session.completed")!;

    await handler(sessionEvent({ mode: "subscription", subscription: "sub_123" }));

    expect(mockRetrieve).toHaveBeenCalledWith("sub_123");
    expect(mockSync).toHaveBeenCalledWith(fakeSub);
  });

  it("credits a top-up payment session (no subscription retrieve/sync)", async () => {
    const handler = getHandler("checkout.session.completed")!;
    await handler(sessionEvent({ mode: "payment", metadata: { kind: "credit_topup" } }));
    expect(mockTopup).toHaveBeenCalledTimes(1);
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("ignores a payment session without the credit_topup marker", async () => {
    const handler = getHandler("checkout.session.completed")!;
    await handler(sessionEvent({ mode: "payment", metadata: { kind: "something_else" } }));
    expect(mockTopup).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("no-ops a subscription session missing a subscription id", async () => {
    const handler = getHandler("checkout.session.completed")!;
    await handler(sessionEvent({ mode: "subscription", subscription: null }));
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });
});
