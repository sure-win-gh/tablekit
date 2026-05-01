import { describe, expect, it } from "vitest";

import { dedupeWithinFile } from "@/lib/import/dedupe";
import type { GuestCandidate } from "@/lib/import/types";

function mk(email: string, firstName = "Jane", notes: string | null = null): GuestCandidate {
  return { firstName, lastName: null, email, phone: null, notes };
}

describe("dedupeWithinFile", () => {
  it("returns input as-is when no duplicates exist", () => {
    const input = [
      { rowNumber: 1, candidate: mk("a@x.io") },
      { rowNumber: 2, candidate: mk("b@x.io") },
      { rowNumber: 3, candidate: mk("c@x.io") },
    ];
    const r = dedupeWithinFile(input);
    expect(r.unique.map((c) => c.email)).toEqual(["a@x.io", "b@x.io", "c@x.io"]);
    expect(r.duplicates).toEqual([]);
  });

  it("collapses two rows with the same email — later wins", () => {
    const input = [
      { rowNumber: 1, candidate: mk("a@x.io", "Old") },
      { rowNumber: 5, candidate: mk("a@x.io", "New") },
    ];
    const r = dedupeWithinFile(input);
    expect(r.unique).toHaveLength(1);
    expect(r.unique[0]?.firstName).toBe("New");
    expect(r.duplicates).toEqual([{ rowNumber: 1, email: "a@x.io" }]);
  });

  it("preserves notes from the later row (latest-wins on collision)", () => {
    const input = [
      { rowNumber: 1, candidate: mk("a@x.io", "Jane", "old notes") },
      { rowNumber: 2, candidate: mk("a@x.io", "Jane", "new notes") },
    ];
    const r = dedupeWithinFile(input);
    expect(r.unique[0]?.notes).toBe("new notes");
  });

  it("reports every earlier occurrence of a triple-duplicated email", () => {
    const input = [
      { rowNumber: 1, candidate: mk("a@x.io") },
      { rowNumber: 2, candidate: mk("a@x.io") },
      { rowNumber: 3, candidate: mk("a@x.io") },
    ];
    const r = dedupeWithinFile(input);
    expect(r.unique).toHaveLength(1);
    expect(r.duplicates).toEqual([
      { rowNumber: 1, email: "a@x.io" },
      { rowNumber: 2, email: "a@x.io" },
    ]);
  });

  it("preserves input order in the unique output", () => {
    // The parser feeds rows in source order, so insertion order ===
    // row-number order in real use. The dedupe relies on that
    // invariant; this test pins it.
    const input = [
      { rowNumber: 1, candidate: mk("a@x.io") },
      { rowNumber: 2, candidate: mk("b@x.io") },
      { rowNumber: 3, candidate: mk("c@x.io") },
      { rowNumber: 5, candidate: mk("e@x.io") },
    ];
    const r = dedupeWithinFile(input);
    expect(r.unique.map((c) => c.email)).toEqual(["a@x.io", "b@x.io", "c@x.io", "e@x.io"]);
  });

  it("returns empty result for empty input", () => {
    const r = dedupeWithinFile([]);
    expect(r).toEqual({ unique: [], duplicates: [] });
  });
});
