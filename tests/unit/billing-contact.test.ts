// Unit coverage for getBillingContact — the read-only Stripe-customer lookup
// behind the Settings → Account billing-contact section. It must degrade to
// null for every "nothing to show" state (Stripe off, no customer, deleted
// customer) and otherwise map the live customer to the BillingContact shape.

import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnabled, mockRetrieve, mockSelect } = vi.hoisted(() => ({
  mockEnabled: vi.fn(),
  mockRetrieve: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/lib/stripe/client", () => ({
  stripeEnabled: mockEnabled,
  stripe: () => ({ customers: { retrieve: mockRetrieve } }),
}));
vi.mock("@/lib/server/admin/db", () => ({ adminDb: () => ({ select: mockSelect }) }));

import { getBillingContact } from "@/lib/billing/contact";

// adminDb().select(...).from(...).where(...).limit(n) resolves to `rows`.
function stubCustomerRow(customerId: string | null): void {
  const rows = customerId === null ? [] : [{ customerId }];
  mockSelect.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  });
}

describe("getBillingContact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnabled.mockReturnValue(true);
  });

  it("returns null when Stripe isn't configured (no DB or API call)", async () => {
    mockEnabled.mockReturnValue(false);
    expect(await getBillingContact("org_1")).toBeNull();
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("returns null when the org has no Stripe customer", async () => {
    stubCustomerRow(null);
    expect(await getBillingContact("org_1")).toBeNull();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("returns null when the customer was deleted in Stripe", async () => {
    stubCustomerRow("cus_123");
    mockRetrieve.mockResolvedValue({ deleted: true } as Stripe.DeletedCustomer);
    expect(await getBillingContact("org_1")).toBeNull();
  });

  it("degrades to null when the Stripe retrieve throws (outage)", async () => {
    stubCustomerRow("cus_123");
    mockRetrieve.mockRejectedValue(new Error("stripe down"));
    expect(await getBillingContact("org_1")).toBeNull();
  });

  it("maps a live customer (with address + tax id) to BillingContact", async () => {
    stubCustomerRow("cus_123");
    mockRetrieve.mockResolvedValue({
      id: "cus_123",
      name: "The Dough Place Ltd",
      email: "billing@dough.co.uk",
      phone: "+447700900000",
      address: {
        line1: "1 High St",
        line2: null,
        city: "London",
        state: null,
        postal_code: "E1 6AN",
        country: "GB",
      },
      tax_ids: { data: [{ type: "gb_vat", value: "GB123456789" }] },
    } as unknown as Stripe.Customer);

    const contact = await getBillingContact("org_1");

    expect(mockRetrieve).toHaveBeenCalledWith("cus_123", { expand: ["tax_ids"] });
    expect(contact).toEqual({
      name: "The Dough Place Ltd",
      email: "billing@dough.co.uk",
      phone: "+447700900000",
      addressLines: ["1 High St", "London", "E1 6AN", "GB"],
      taxId: "GB_VAT GB123456789",
    });
  });

  it("tolerates a customer with no address or tax ids", async () => {
    stubCustomerRow("cus_123");
    mockRetrieve.mockResolvedValue({
      id: "cus_123",
      name: "Solo Cafe",
      email: null,
      phone: null,
      address: null,
    } as unknown as Stripe.Customer);

    const contact = await getBillingContact("org_1");

    expect(contact).toEqual({
      name: "Solo Cafe",
      email: null,
      phone: null,
      addressLines: [],
      taxId: null,
    });
  });
});
