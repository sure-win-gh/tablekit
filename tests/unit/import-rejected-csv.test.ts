import { describe, expect, it } from "vitest";

import { buildRejectedRowsCsv } from "@/lib/import/rejected-csv";

describe("buildRejectedRowsCsv", () => {
  it("returns empty string for an empty rejected set", () => {
    expect(buildRejectedRowsCsv([])).toBe("");
  });

  it("emits a BOM + header + a row with structured error reasons", () => {
    const csv = buildRejectedRowsCsv([
      {
        rowNumber: 3,
        raw: { "First Name": "Jane", Email: "" },
        errors: [{ reason: "missing-required", field: "email" }],
      },
    ]);
    // BOM, then header line, then one data row.
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("row_number,errors,First Name,Email");
    expect(lines[1]).toBe("3,missing-required:email,Jane,");
    expect(lines[2]).toBe(""); // trailing CRLF
  });

  it("escapes cells containing commas + quotes per RFC 4180", () => {
    const csv = buildRejectedRowsCsv([
      {
        rowNumber: 1,
        raw: { Note: 'Has, comma and "quote"' },
        errors: [{ reason: "field-too-long", field: "notes", max: 100 }],
      },
    ]);
    expect(csv).toContain('"Has, comma and ""quote"""');
    expect(csv).toContain("field-too-long:notes(max=100)");
  });

  it("guards against CSV formula injection on leading =/+/-/@", () => {
    const csv = buildRejectedRowsCsv([
      {
        rowNumber: 1,
        raw: { Name: "=cmd|calc", Email: "+44 123" },
        errors: [{ reason: "invalid-email", value: "+44 123" }],
      },
    ]);
    // Each formula-shaped cell is prefixed with a single quote.
    expect(csv).toContain("'=cmd|calc");
    expect(csv).toContain("'+44 123");
  });

  it("collects the union of headers across rejected rows in first-seen order", () => {
    const csv = buildRejectedRowsCsv([
      {
        rowNumber: 1,
        raw: { Email: "a@a.test" },
        errors: [{ reason: "invalid-email", value: "a@a.test" }],
      },
      {
        rowNumber: 2,
        raw: { Email: "b@b.test", Phone: "0123" },
        errors: [{ reason: "missing-required", field: "firstName" }],
      },
    ]);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("row_number,errors,Email,Phone");
  });
});
