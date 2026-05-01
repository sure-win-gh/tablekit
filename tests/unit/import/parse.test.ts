import { describe, expect, it } from "vitest";

import { parseCsv } from "@/lib/import/parse";

describe("parseCsv", () => {
  it("parses a header row + records into Record<string,string>", () => {
    const csv = "First Name,Email\nJane,jane@example.com\nJoe,joe@example.com\n";
    const r = parseCsv(csv);
    expect(r.headers).toEqual(["First Name", "Email"]);
    expect(r.rows).toEqual([
      { "First Name": "Jane", Email: "jane@example.com" },
      { "First Name": "Joe", Email: "joe@example.com" },
    ]);
    expect(r.parseErrors).toEqual([]);
  });

  it("trims header whitespace + cell whitespace", () => {
    const csv = "  Name  ,  Email  \n  Jane  ,  jane@example.com  \n";
    const r = parseCsv(csv);
    expect(r.headers).toEqual(["Name", "Email"]);
    expect(r.rows[0]).toEqual({ Name: "Jane", Email: "jane@example.com" });
  });

  it("skips fully-empty lines without flagging them", () => {
    const csv = "Name,Email\nJane,jane@example.com\n\n\nJoe,joe@example.com\n";
    const r = parseCsv(csv);
    expect(r.rows).toHaveLength(2);
    expect(r.parseErrors).toEqual([]);
  });

  it("handles quoted fields containing commas", () => {
    const csv = 'Name,Notes\nJane,"likes window seats, allergic to nuts"\n';
    const r = parseCsv(csv);
    expect(r.rows[0]).toEqual({
      Name: "Jane",
      Notes: "likes window seats, allergic to nuts",
    });
  });

  it("returns empty rows + headers for an empty file", () => {
    const r = parseCsv("");
    expect(r.headers).toEqual([]);
    expect(r.rows).toEqual([]);
  });

  it("returns headers but zero rows when only a header is present", () => {
    const r = parseCsv("Name,Email\n");
    expect(r.headers).toEqual(["Name", "Email"]);
    expect(r.rows).toEqual([]);
  });
});
