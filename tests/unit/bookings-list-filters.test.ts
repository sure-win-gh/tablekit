import { describe, expect, it } from "vitest";

import { classifySearchInput, parseStatusFilter } from "@/lib/bookings/list-filters";

describe("classifySearchInput", () => {
  it("returns empty for undefined / blank / whitespace", () => {
    expect(classifySearchInput(undefined)).toEqual({ kind: "empty" });
    expect(classifySearchInput("")).toEqual({ kind: "empty" });
    expect(classifySearchInput("   ")).toEqual({ kind: "empty" });
  });

  it("classifies as email when input contains @", () => {
    expect(classifySearchInput("jane@example.com")).toEqual({
      kind: "email",
      raw: "jane@example.com",
    });
    // We don't validate format — an `@` alone routes through email.
    expect(classifySearchInput("not.really@an.email.because.who.cares")).toEqual({
      kind: "email",
      raw: "not.really@an.email.because.who.cares",
    });
  });

  it("trims whitespace before classifying", () => {
    expect(classifySearchInput("  jane@example.com  ")).toEqual({
      kind: "email",
      raw: "jane@example.com",
    });
    expect(classifySearchInput("  Jane  ")).toEqual({
      kind: "freetext",
      pattern: "%Jane%",
    });
  });

  it("wraps freetext input in ILIKE wildcards", () => {
    expect(classifySearchInput("birthday")).toEqual({
      kind: "freetext",
      pattern: "%birthday%",
    });
  });

  it("escapes ILIKE metacharacters so user input is literal", () => {
    expect(classifySearchInput("50%")).toEqual({
      kind: "freetext",
      pattern: "%50\\%%",
    });
    expect(classifySearchInput("a_b")).toEqual({
      kind: "freetext",
      pattern: "%a\\_b%",
    });
    expect(classifySearchInput("back\\slash")).toEqual({
      kind: "freetext",
      pattern: "%back\\\\slash%",
    });
  });
});

describe("parseStatusFilter", () => {
  it("returns empty for undefined / blank", () => {
    expect(parseStatusFilter(undefined)).toEqual([]);
    expect(parseStatusFilter("")).toEqual([]);
  });

  it("parses comma-separated tokens", () => {
    expect(parseStatusFilter("confirmed,seated")).toEqual(["confirmed", "seated"]);
  });

  it("trims whitespace and ignores unknown tokens", () => {
    expect(parseStatusFilter(" confirmed , wibble , no_show ")).toEqual(["confirmed", "no_show"]);
  });

  it("returns empty when no token survives validation", () => {
    expect(parseStatusFilter("xxx,yyy")).toEqual([]);
  });
});
