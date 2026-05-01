import { describe, expect, it } from "vitest";

import { runPipeline } from "@/lib/import/runner/pipeline";
import type { ColumnMap } from "@/lib/import/types";

const defaultMap: ColumnMap = {
  firstName: "First",
  lastName: "Last",
  email: "Email",
  phone: "Phone",
  notes: "Notes",
};

const fakeHash = (email: string): string => `h(${email})`;

describe("runPipeline", () => {
  it("happy path — three valid rows, no collisions", () => {
    const csv =
      "First,Last,Email,Phone,Notes\n" +
      "Jane,Doe,jane@example.com,07700900123,window\n" +
      "Joe,Bloggs,joe@example.com,,\n" +
      "Kit,Smith,kit@example.com,,\n";
    const r = runPipeline({
      csvText: csv,
      columnMap: defaultMap,
      existingEmailHashes: new Set(),
      hashEmail: fakeHash,
    });
    expect(r.candidates.map((c) => c.email)).toEqual([
      "jane@example.com",
      "joe@example.com",
      "kit@example.com",
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.withinFileDuplicates).toEqual([]);
    expect(r.existingCollisions).toEqual([]);
    expect(r.totalRows).toBe(3);
  });

  it("partitions into candidates, rejected, within-file dupes, and existing collisions", () => {
    const csv =
      "First,Email\n" +
      "Jane,jane@example.com\n" + // existing collision
      "Joe,joe@example.com\n" + // imports
      ",no-name@example.com\n" + // rejected: missing firstName
      "Kit,kit@example.com\n" + // imports (first sighting)
      "Kit,kit@example.com\n"; // within-file dup of row 4
    const r = runPipeline({
      csvText: csv,
      columnMap: { firstName: "First", email: "Email" },
      existingEmailHashes: new Set([fakeHash("jane@example.com")]),
      hashEmail: fakeHash,
    });

    expect(r.candidates.map((c) => c.email)).toEqual(["joe@example.com", "kit@example.com"]);
    expect(r.existingCollisions.map((c) => c.candidate.email)).toEqual(["jane@example.com"]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.errors[0]).toEqual({
      reason: "missing-required",
      field: "firstName",
    });
    expect(r.withinFileDuplicates).toEqual([{ rowNumber: 4, email: "kit@example.com" }]);
    expect(r.totalRows).toBe(5);
  });

  it("does not treat a within-file dup of a colliding-with-existing email as a candidate", () => {
    // Two rows for jane@; she already exists in the org. Both get
    // counted: one as a within-file dup (later wins), the surviving
    // row as an existing collision (not inserted). Net candidates: 0.
    const csv = "First,Email\nJane,jane@example.com\nJane,jane@example.com\n";
    const r = runPipeline({
      csvText: csv,
      columnMap: { firstName: "First", email: "Email" },
      existingEmailHashes: new Set([fakeHash("jane@example.com")]),
      hashEmail: fakeHash,
    });
    expect(r.candidates).toEqual([]);
    expect(r.withinFileDuplicates).toHaveLength(1);
    expect(r.existingCollisions).toHaveLength(1);
  });

  it("propagates parse errors without dropping valid rows", () => {
    const csv = 'First,Email\nJane,jane@example.com\n"unterminated,quote\n';
    const r = runPipeline({
      csvText: csv,
      columnMap: { firstName: "First", email: "Email" },
      existingEmailHashes: new Set(),
      hashEmail: fakeHash,
    });
    // Jane's row should have made it through.
    expect(r.candidates.length).toBeGreaterThanOrEqual(1);
    // Papaparse surfaced at least one parse error.
    expect(r.parseErrors.length).toBeGreaterThan(0);
  });

  it("handles an empty CSV gracefully", () => {
    const r = runPipeline({
      csvText: "",
      columnMap: defaultMap,
      existingEmailHashes: new Set(),
      hashEmail: fakeHash,
    });
    expect(r.candidates).toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(r.totalRows).toBe(0);
  });
});
