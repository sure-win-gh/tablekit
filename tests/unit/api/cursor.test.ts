// Unit tests for cursor + limit helpers used by v1 list endpoints.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  parseLimit,
} from "@/lib/api/v1/cursor";

describe("parseLimit", () => {
  it("returns DEFAULT_LIMIT when raw is null", () => {
    expect(parseLimit(null)).toBe(DEFAULT_LIMIT);
  });

  it("clamps to MAX_LIMIT when raw exceeds it", () => {
    expect(parseLimit(String(MAX_LIMIT + 50))).toBe(MAX_LIMIT);
  });

  it("returns DEFAULT_LIMIT for non-numeric input", () => {
    expect(parseLimit("nope")).toBe(DEFAULT_LIMIT);
  });

  it("returns DEFAULT_LIMIT for zero or negative", () => {
    expect(parseLimit("0")).toBe(DEFAULT_LIMIT);
    expect(parseLimit("-5")).toBe(DEFAULT_LIMIT);
  });

  it("respects a sensible value", () => {
    expect(parseLimit("25")).toBe(25);
  });
});

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a cursor", () => {
    const c = { k: "2026-05-09T12:00:00.000Z", i: "00000000-0000-0000-0000-000000000001" };
    const encoded = encodeCursor(c);
    expect(decodeCursor(encoded)).toEqual(c);
  });

  it("returns null for null input", () => {
    expect(decodeCursor(null)).toBeNull();
  });

  it("returns null for malformed base64", () => {
    expect(decodeCursor("!!!not-base64!!!")).toBeNull();
  });

  it("returns null for valid base64 but malformed JSON", () => {
    const bad = Buffer.from("not json at all", "utf8").toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null for JSON missing required fields", () => {
    const bad = Buffer.from(JSON.stringify({ wrong: "shape" }), "utf8").toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("encodes to URL-safe base64 (no + / =)", () => {
    const encoded = encodeCursor({ k: "2026-05-09T12:00:00.000Z", i: "abc" });
    expect(encoded).not.toMatch(/[+/=]/);
  });
});
