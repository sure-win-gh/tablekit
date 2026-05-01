import { describe, expect, it } from "vitest";

import { suggestMapping } from "@/lib/import/suggest-mapping";
import { ADAPTERS, detectSource, getAdapter } from "@/lib/import/sources";

describe("detectSource", () => {
  it("returns null when nothing matches", () => {
    expect(detectSource(["Birthday", "Address"])).toBeNull();
    expect(detectSource([])).toBeNull();
  });

  it("detects OpenTable from the canonical signature", () => {
    expect(detectSource(["First Name", "Last Name", "Email", "Reservation Date", "Notes"])).toBe(
      "opentable",
    );
  });

  it("detects ResDiary from the 'Customer …' prefix", () => {
    expect(detectSource(["Customer First Name", "Customer Email", "Customer Phone"])).toBe(
      "resdiary",
    );
  });

  it("detects SevenRooms from the VIP-Status signature", () => {
    expect(detectSource(["First Name", "Last Name", "Email", "VIP Status", "Tags"])).toBe(
      "sevenrooms",
    );
  });

  it("is case + punctuation insensitive", () => {
    expect(detectSource(["FIRST_NAME", "last_name", "EMAIL", "reservation-date"])).toBe(
      "opentable",
    );
  });

  it("prefers ResDiary over OpenTable when both signatures could apply", () => {
    // ResDiary's signature is stricter; if "Customer First Name" is
    // present, that wins even if "First Name" is also there as a
    // duplicate column.
    const headers = ["Customer First Name", "Customer Email", "First Name", "Last Name"];
    expect(detectSource(headers)).toBe("resdiary");
  });

  it("prefers SevenRooms over OpenTable when both signatures match", () => {
    // SevenRooms exports often include reservation-side columns,
    // so a file with BOTH "VIP Status" AND "Reservation Date"
    // should resolve to SevenRooms (the more discriminating
    // signature). Regression guard for the priority-order bug
    // that would otherwise misroute SevenRooms files to OpenTable.
    const headers = ["First Name", "Last Name", "Email", "Reservation Date", "VIP Status", "Tags"];
    expect(detectSource(headers)).toBe("sevenrooms");
  });
});

describe("getAdapter", () => {
  it("returns null for generic-csv", () => {
    expect(getAdapter("generic-csv")).toBeNull();
  });

  it("returns the matching adapter for known sources", () => {
    expect(getAdapter("opentable")?.source).toBe("opentable");
    expect(getAdapter("resdiary")?.source).toBe("resdiary");
    expect(getAdapter("sevenrooms")?.source).toBe("sevenrooms");
  });
});

describe("ADAPTERS — sanity", () => {
  it("every adapter pins firstName + email candidates", () => {
    for (const a of ADAPTERS) {
      expect(a.candidates.firstName?.length ?? 0).toBeGreaterThan(0);
      expect(a.candidates.email?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("suggestMapping with adapter", () => {
  it("uses ResDiary's 'Customer …' candidates when source is resdiary", () => {
    const out = suggestMapping(
      ["Customer First Name", "Customer Surname", "Customer Email"],
      "resdiary",
    );
    expect(out.firstName).toBe("Customer First Name");
    expect(out.lastName).toBe("Customer Surname");
    expect(out.email).toBe("Customer Email");
  });

  it("falls back to generic candidates when the adapter doesn't pin a field", () => {
    // sevenrooms adapter has no `notes` mapping at present (defined
    // it generically); the generic "notes" / "comments" path picks
    // up a custom column.
    const out = suggestMapping(
      ["First Name", "Last Name", "Email", "VIP Status", "Comments"],
      "sevenrooms",
    );
    expect(out.notes).toBe("Comments");
  });

  it("ignores the adapter when no source is supplied (generic-csv path)", () => {
    const out = suggestMapping(["Customer First Name", "Customer Email"]);
    // No adapter → generic candidates only. "Customer First Name"
    // doesn't match the generic "first name" candidates exactly,
    // so firstName stays unset.
    expect(out.firstName).toBeUndefined();
    expect(out.email).toBeUndefined();
  });

  it("respects priority order — adapter candidate wins over generic", () => {
    // ResDiary adapter lists "Customer First Name" first, then
    // "FirstName", then "First Name". When all three are present,
    // we get the most specific one.
    const out = suggestMapping(["Customer First Name", "FirstName", "First Name"], "resdiary");
    expect(out.firstName).toBe("Customer First Name");
  });
});
