// CSV serialiser — RFC 4180 edge cases + the BOM/CRLF opinions.

import { describe, expect, it } from "vitest";

import { toCsv } from "@/lib/reports/csv";

const BOM = "﻿";

describe("toCsv", () => {
  it("emits BOM + CRLF + header + rows + trailing CRLF", () => {
    const out = toCsv([{ a: 1, b: 2 }], [
      { header: "a", value: (r) => r.a },
      { header: "b", value: (r) => r.b },
    ]);
    expect(out).toBe(BOM + "a,b\r\n1,2\r\n");
  });

  it("quotes values containing commas, quotes, or newlines", () => {
    const out = toCsv(
      [{ note: 'has, "quotes" and\nnewline' }],
      [{ header: "note", value: (r) => r.note }],
    );
    // Quote the field; double the inner quotes.
    expect(out).toBe(BOM + 'note\r\n"has, ""quotes"" and\nnewline"\r\n');
  });

  it("does not quote plain ascii values", () => {
    const out = toCsv([{ name: "alice" }], [{ header: "name", value: (r) => r.name }]);
    expect(out).toBe(BOM + "name\r\nalice\r\n");
  });

  it("renders null/undefined as empty string", () => {
    const out = toCsv(
      [{ a: null, b: undefined }],
      [
        { header: "a", value: (r) => r.a },
        { header: "b", value: (r) => r.b },
      ],
    );
    expect(out).toBe(BOM + "a,b\r\n,\r\n");
  });

  it("renders Date as ISO", () => {
    const out = toCsv(
      [{ d: new Date("2026-04-26T12:00:00Z") }],
      [{ header: "d", value: (r) => r.d }],
    );
    expect(out).toBe(BOM + "d\r\n2026-04-26T12:00:00.000Z\r\n");
  });

  it("emits header-only (BOM + CRLF) when rows are empty", () => {
    const out = toCsv([] as Array<{ a: number }>, [{ header: "a", value: (r) => r.a }]);
    expect(out).toBe(BOM + "a\r\n");
  });
});
