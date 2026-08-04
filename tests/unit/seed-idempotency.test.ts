import { describe, expect, it } from "vitest";

import { buildGuestPool, diffRowCounts } from "../../scripts/seed/idempotency";

describe("buildGuestPool — stable identities", () => {
  it("is deterministic: the same size + prefix yields identical pools", () => {
    expect(buildGuestPool(30, "v0")).toEqual(buildGuestPool(30, "v0"));
  });

  it("produces unique, non-deliverable emails", () => {
    const pool = buildGuestPool(60);
    const emails = pool.map((g) => g.email);
    expect(new Set(emails).size).toBe(emails.length);
    expect(emails.every((e) => e.endsWith("@example.invalid"))).toBe(true);
  });

  it("a prefix keeps two venues' pools from colliding on email", () => {
    const a = buildGuestPool(25, "v0-aaaa1111").map((g) => g.email);
    const b = buildGuestPool(25, "v1-bbbb2222").map((g) => g.email);
    expect(a.some((e) => b.includes(e))).toBe(false);
  });

  it("index i always maps to the same name (idempotent re-seed)", () => {
    const first = buildGuestPool(5);
    const again = buildGuestPool(5);
    for (let i = 0; i < 5; i++) {
      expect(again[i]!.firstName).toBe(first[i]!.firstName);
      expect(again[i]!.lastName).toBe(first[i]!.lastName);
    }
  });
});

describe("diffRowCounts — double-run verification", () => {
  it("reports no differences for identical snapshots (idempotent run)", () => {
    const snap = { bookings: 120, guests: 71, venues: 4 };
    expect(diffRowCounts(snap, snap)).toEqual([]);
  });

  it("reports only the tables whose counts changed", () => {
    const before = { bookings: 120, guests: 71, venues: 4 };
    const after = { bookings: 121, guests: 71, venues: 4 };
    expect(diffRowCounts(before, after)).toEqual([{ table: "bookings", before: 120, after: 121 }]);
  });

  it("treats a missing key as zero on either side", () => {
    expect(diffRowCounts({}, { waitlists: 4 })).toEqual([
      { table: "waitlists", before: 0, after: 4 },
    ]);
    expect(diffRowCounts({ waitlists: 4 }, {})).toEqual([
      { table: "waitlists", before: 4, after: 0 },
    ]);
  });
});
