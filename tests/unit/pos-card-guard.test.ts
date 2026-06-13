// Unit tests for the POS card-data guard (PCI SAQ-A backstop).
//
// Proves a card-number-shaped value is detected and stripped from a
// normalised order before persistence, and that legitimate fields (a
// masked "Visa ••4242" label, "Cash", a table number) are left intact.

import { describe, expect, it } from "vitest";

import { looksLikeCardNumber, stripCardData } from "@/lib/pos/card-guard";
import type { NormalisedOrder } from "@/lib/pos/types";

function order(overrides: Partial<NormalisedOrder>): NormalisedOrder {
  return {
    provider: "generic",
    externalOrderId: "ext-1",
    totalMinor: 4200,
    tipMinor: 0,
    taxMinor: null,
    currency: "GBP",
    coverCount: 2,
    paymentMethodLabel: null,
    closedAt: new Date("2026-05-10T20:00:00Z"),
    customerEmail: null,
    customerPhone: null,
    bookingRef: null,
    lineItems: null,
    rawProviderRef: null,
    ...overrides,
  };
}

describe("looksLikeCardNumber", () => {
  it("flags 13–19 digit runs that pass Luhn (with or without separators)", () => {
    expect(looksLikeCardNumber("4242424242424242")).toBe(true);
    expect(looksLikeCardNumber("4242 4242 4242 4242")).toBe(true);
    expect(looksLikeCardNumber("4242-4242-4242-4242")).toBe(true);
    expect(looksLikeCardNumber("4111111111111111")).toBe(true);
  });

  it("ignores masked labels, short numbers, and non-Luhn runs", () => {
    expect(looksLikeCardNumber("Visa ••4242")).toBe(false);
    expect(looksLikeCardNumber("Cash")).toBe(false);
    expect(looksLikeCardNumber("4242")).toBe(false); // table number
    expect(looksLikeCardNumber("4242424242424243")).toBe(false); // fails Luhn
    expect(looksLikeCardNumber("12345")).toBe(false);
  });
});

describe("stripCardData", () => {
  it("blanks a card-number-shaped payment label and records the field", () => {
    const { order: out, scrubbed } = stripCardData(
      order({ paymentMethodLabel: "4242424242424242" }),
    );
    expect(out.paymentMethodLabel).toBeNull();
    expect(scrubbed).toContain("paymentMethodLabel");
  });

  it("keeps a masked label and clean fields untouched", () => {
    const { order: out, scrubbed } = stripCardData(
      order({ paymentMethodLabel: "Visa ••4242", rawProviderRef: "sq_pay_abc" }),
    );
    expect(out.paymentMethodLabel).toBe("Visa ••4242");
    expect(out.rawProviderRef).toBe("sq_pay_abc");
    expect(scrubbed).toHaveLength(0);
  });

  it("redacts a card-number-shaped line-item name but keeps the rest", () => {
    const { order: out, scrubbed } = stripCardData(
      order({
        lineItems: [
          { name: "Flat white", quantity: 2, totalMinor: 600 },
          { name: "4111 1111 1111 1111", quantity: 1, totalMinor: 0 },
        ],
      }),
    );
    expect(out.lineItems?.[0]?.name).toBe("Flat white");
    expect(out.lineItems?.[1]?.name).toBe("[redacted]");
    expect(scrubbed).toContain("lineItems[1].name");
  });
});
