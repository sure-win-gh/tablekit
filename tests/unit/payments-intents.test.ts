// Unit tests for lib/payments/intents.ts.
//
// Full createDepositIntent exercises the DB and Stripe SDK, so we lean
// on mocks for the Stripe half and on a small in-memory adminDb to
// assert the contract: amount calculation, idempotency key shape, 3DS
// forced, direct-charge (stripeAccount header, no on_behalf_of),
// metadata propagation, kill-switch behaviour.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { depositAmountMinor, DepositIntentError } from "@/lib/payments/intents";
import type { DepositRule } from "@/lib/payments/rules";

function mkRule(overrides: Partial<DepositRule> = {}): DepositRule {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    organisationId: "00000000-0000-0000-0000-00000000aaaa",
    venueId: "00000000-0000-0000-0000-00000000bbbb",
    serviceId: null,
    minParty: 1,
    maxParty: null,
    dayOfWeek: [0, 1, 2, 3, 4, 5, 6],
    kind: "flat",
    amountMinor: 2000,
    currency: "GBP",
    refundWindowHours: 24,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("depositAmountMinor", () => {
  it("flat → amount verbatim regardless of party size", () => {
    expect(depositAmountMinor(mkRule({ kind: "flat", amountMinor: 2000 }), 4)).toBe(2000);
  });

  it("per_cover → amount * partySize", () => {
    expect(depositAmountMinor(mkRule({ kind: "per_cover", amountMinor: 1000 }), 4)).toBe(4000);
    expect(depositAmountMinor(mkRule({ kind: "per_cover", amountMinor: 1000 }), 1)).toBe(1000);
  });

  it("card_hold → throws; flow B doesn't belong in the deposit path", () => {
    expect(() => depositAmountMinor(mkRule({ kind: "card_hold" }), 2)).toThrow(DepositIntentError);
  });
});

describe("createDepositIntent — Stripe contract assertions", () => {
  // Reset module cache between tests so our mock setup applies fresh.
  beforeEach(() => {
    vi.resetModules();
    process.env["STRIPE_SECRET_KEY"] = "sk_test_51" + "a".repeat(100);
    delete process.env["PAYMENTS_DISABLED"];
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("throws DepositIntentError when the kill switch is set", async () => {
    process.env["PAYMENTS_DISABLED"] = "true";
    const { createDepositIntent } = await import("@/lib/payments/intents");
    // Asserting by name (not instanceof) because vi.resetModules()
    // means the dynamically-imported module has its own class object
    // distinct from the statically-imported DepositIntentError above.
    await expect(
      createDepositIntent({
        organisationId: "org",
        bookingId: "bk",
        paymentId: "pay",
        guestId: "g",
        partySize: 2,
        rule: mkRule(),
        stripeAccountId: "acct_test",
      }),
    ).rejects.toMatchObject({ name: "DepositIntentError", code: "payments-disabled" });
  });

  it("calls Stripe with 3DS forced + idempotency key + stripeAccount header + metadata", async () => {
    // Captures the exact args passed to paymentIntents.create and
    // customers.create so we can assert the Connect-Standard contract.
    const captured: {
      customerArgs?: [unknown, unknown];
      piArgs?: [unknown, unknown];
    } = {};

    vi.doMock("@/lib/stripe/client", () => ({
      paymentsDisabled: () => false,
      stripeEnabled: () => true,
      stripe: () => ({
        customers: {
          create: vi.fn(async (body: unknown, opts: unknown) => {
            captured.customerArgs = [body, opts];
            return { id: "cus_test_1" };
          }),
        },
        paymentIntents: {
          create: vi.fn(async (body: unknown, opts: unknown) => {
            captured.piArgs = [body, opts];
            return {
              id: "pi_test_1",
              status: "requires_payment_method",
              client_secret: "pi_test_1_secret_xyz",
            };
          }),
        },
      }),
    }));

    // Fake adminDb: returns no existing customer_id for the guest, and
    // swallows update + insert + select calls against payments/guests.
    vi.doMock("@/lib/server/admin/db", () => ({
      adminDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ stripeCustomerId: null }],
            }),
          }),
        }),
        update: () => ({
          set: () => ({
            where: async () => undefined,
          }),
        }),
      }),
    }));

    vi.doMock("@/lib/server/admin/audit", () => ({
      audit: { log: vi.fn(async () => undefined) },
    }));

    const { createDepositIntent } = await import("@/lib/payments/intents");

    const result = await createDepositIntent({
      organisationId: "org_uuid",
      bookingId: "booking_uuid",
      paymentId: "payment_uuid",
      guestId: "guest_uuid",
      partySize: 3,
      rule: mkRule({ kind: "per_cover", amountMinor: 1500 }),
      stripeAccountId: "acct_test_connect",
    });

    // Result shape
    expect(result.intentId).toBe("pi_test_1");
    expect(result.clientSecret).toBe("pi_test_1_secret_xyz");
    expect(result.amountMinor).toBe(4500); // 1500 * 3

    // Customer creation: direct-charge (stripeAccount set), idempotency
    // key derived from guest id so concurrent bookings converge.
    expect(captured.customerArgs).toBeDefined();
    const [custBody, custOpts] = captured.customerArgs!;
    expect(custBody).toMatchObject({
      metadata: { guest_id: "guest_uuid", organisation_id: "org_uuid" },
    });
    expect(custOpts).toMatchObject({
      idempotencyKey: "guest_guest_uuid_customer_v1",
      stripeAccount: "acct_test_connect",
    });

    // PaymentIntent: 3DS forced, currency lowercased, direct charge
    // (no on_behalf_of), idempotency key pinned to the booking.
    expect(captured.piArgs).toBeDefined();
    const [piBody, piOpts] = captured.piArgs!;
    expect(piBody).toMatchObject({
      amount: 4500,
      currency: "gbp",
      customer: "cus_test_1",
      capture_method: "automatic",
      payment_method_options: { card: { request_three_d_secure: "any" } },
      metadata: {
        booking_id: "booking_uuid",
        payment_id: "payment_uuid",
        organisation_id: "org_uuid",
        kind: "deposit",
      },
    });
    expect(piBody).not.toHaveProperty("on_behalf_of");
    expect(piBody).not.toHaveProperty("transfer_data");
    expect(piOpts).toMatchObject({
      idempotencyKey: "booking_booking_uuid_deposit_v1",
      stripeAccount: "acct_test_connect",
    });
  });

  it("reuses an existing Stripe Customer if guests.stripe_customer_id is populated", async () => {
    const customersCreate = vi.fn();
    vi.doMock("@/lib/stripe/client", () => ({
      paymentsDisabled: () => false,
      stripeEnabled: () => true,
      stripe: () => ({
        customers: { create: customersCreate },
        paymentIntents: {
          create: async () => ({
            id: "pi_test_2",
            status: "requires_payment_method",
            client_secret: "secret",
          }),
        },
      }),
    }));
    vi.doMock("@/lib/server/admin/db", () => ({
      adminDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ stripeCustomerId: "cus_existing" }],
            }),
          }),
        }),
        update: () => ({
          set: () => ({
            where: async () => undefined,
          }),
        }),
      }),
    }));
    vi.doMock("@/lib/server/admin/audit", () => ({
      audit: { log: async () => undefined },
    }));

    const { createDepositIntent } = await import("@/lib/payments/intents");
    await createDepositIntent({
      organisationId: "org",
      bookingId: "bk",
      paymentId: "pay",
      guestId: "g",
      partySize: 2,
      rule: mkRule(),
      stripeAccountId: "acct_x",
    });

    expect(customersCreate).not.toHaveBeenCalled();
  });
});
