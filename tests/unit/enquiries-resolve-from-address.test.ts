// Behavioural test for resolveFromAddress.
//
// The function is a thin DB lookup, so the unit test stubs adminDb's
// query builder via the env-driven Resend module path. We mock @/lib/
// server/admin/db's adminDb() to return a faked drizzle query chain.

import { describe, expect, it, vi, beforeEach } from "vitest";

// Hoisted holder for the row the next call to `db.select(...)` should
// resolve with. Each test sets this before calling resolveFromAddress.
const mockHolder = vi.hoisted(() => ({ row: undefined as unknown }));

vi.mock("@/lib/server/admin/db", () => ({
  adminDb: () => ({
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: async () => (mockHolder.row === undefined ? [] : [mockHolder.row]),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/email/client", () => ({
  fromEmail: () => "TableKit <no-reply@tablekit.test>",
}));

import { resolveFromAddress } from "@/lib/enquiries/send-reply";

beforeEach(() => {
  mockHolder.row = undefined;
});

describe("resolveFromAddress", () => {
  it("falls back to platform sender when no venue row matches", async () => {
    mockHolder.row = undefined;
    const r = await resolveFromAddress("venue-id");
    expect(r).toBe("TableKit <no-reply@tablekit.test>");
  });

  it("falls back when no sending domain is registered (left-join nulls)", async () => {
    mockHolder.row = { slug: "jane-cafe", domain: null, status: null };
    const r = await resolveFromAddress("venue-id");
    expect(r).toBe("TableKit <no-reply@tablekit.test>");
  });

  it("falls back when the domain is registered but not yet verified", async () => {
    mockHolder.row = { slug: "jane-cafe", domain: "mail.jane.test", status: "pending" };
    const r = await resolveFromAddress("venue-id");
    expect(r).toBe("TableKit <no-reply@tablekit.test>");
  });

  it("falls back when the domain dropped into failure", async () => {
    mockHolder.row = { slug: "jane-cafe", domain: "mail.jane.test", status: "failure" };
    const r = await resolveFromAddress("venue-id");
    expect(r).toBe("TableKit <no-reply@tablekit.test>");
  });

  it("uses slug@verified-domain when status is verified", async () => {
    mockHolder.row = { slug: "jane-cafe", domain: "mail.jane.test", status: "verified" };
    const r = await resolveFromAddress("venue-id");
    expect(r).toBe("jane-cafe@mail.jane.test");
  });

  it("falls back if the venue has no slug (defensive — inbound webhook routes by slug so this shouldn't reach send)", async () => {
    mockHolder.row = { slug: null, domain: "mail.jane.test", status: "verified" };
    const r = await resolveFromAddress("venue-id");
    expect(r).toBe("TableKit <no-reply@tablekit.test>");
  });
});
