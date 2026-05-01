import { describe, expect, it } from "vitest";

import { dedupeAgainstExistingHashes } from "@/lib/import/runner/dedupe-existing";
import type { GuestCandidate } from "@/lib/import/types";

function mk(email: string, firstName = "Jane"): GuestCandidate {
  return { firstName, lastName: null, email, phone: null, notes: null };
}

// Trivial deterministic stand-in. The real thing is HMAC under the
// master key — pure / deterministic, so a fake-hash is sound for
// these tests.
const fakeHash = (email: string): string => `h(${email})`;

describe("dedupeAgainstExistingHashes", () => {
  it("inserts everything when the existing set is empty", () => {
    const candidates = [mk("a@x.io"), mk("b@x.io")];
    const r = dedupeAgainstExistingHashes(candidates, fakeHash, new Set());
    expect(r.toInsert.map((c) => c.email)).toEqual(["a@x.io", "b@x.io"]);
    expect(r.collisions).toEqual([]);
  });

  it("collides everything when every candidate's hash is already known", () => {
    const candidates = [mk("a@x.io"), mk("b@x.io")];
    const existing = new Set([fakeHash("a@x.io"), fakeHash("b@x.io")]);
    const r = dedupeAgainstExistingHashes(candidates, fakeHash, existing);
    expect(r.toInsert).toEqual([]);
    expect(r.collisions).toHaveLength(2);
  });

  it("partitions candidates into insert / collide buckets", () => {
    const candidates = [mk("a@x.io"), mk("b@x.io"), mk("c@x.io"), mk("d@x.io")];
    const existing = new Set([fakeHash("b@x.io"), fakeHash("d@x.io")]);
    const r = dedupeAgainstExistingHashes(candidates, fakeHash, existing);
    expect(r.toInsert.map((c) => c.email)).toEqual(["a@x.io", "c@x.io"]);
    expect(r.collisions.map((c) => c.candidate.email)).toEqual(["b@x.io", "d@x.io"]);
  });

  it("surfaces the matching email hash on each collision so the writer can update", () => {
    const candidates = [mk("a@x.io")];
    const existing = new Set([fakeHash("a@x.io")]);
    const r = dedupeAgainstExistingHashes(candidates, fakeHash, existing);
    expect(r.collisions[0]?.existingEmailHash).toBe("h(a@x.io)");
  });

  it("returns empty arrays for empty input", () => {
    const r = dedupeAgainstExistingHashes([], fakeHash, new Set(["whatever"]));
    expect(r).toEqual({ toInsert: [], collisions: [] });
  });
});
