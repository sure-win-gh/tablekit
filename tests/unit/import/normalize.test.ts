import { describe, expect, it } from "vitest";

import { isPlausibleEmail, normaliseEmail, normalisePhone } from "@/lib/import/normalize";

describe("normaliseEmail", () => {
  it("trims whitespace and lowercases", () => {
    expect(normaliseEmail("  Jane@Example.COM  ")).toBe("jane@example.com");
  });

  it("preserves dots and plus aliases", () => {
    expect(normaliseEmail("Jane.Doe+bookings@Example.com")).toBe("jane.doe+bookings@example.com");
  });
});

describe("isPlausibleEmail", () => {
  it.each(["jane@example.com", "jane.doe@example.co.uk", "j+a@x.io", "a@b.co"])(
    "accepts plausible address %s",
    (e) => {
      expect(isPlausibleEmail(e)).toBe(true);
    },
  );

  it.each([
    "",
    " ",
    "jane",
    "jane@",
    "@example.com",
    "jane@example",
    "jane @ example.com",
    "jane@@example.com",
  ])("rejects malformed %s", (e) => {
    expect(isPlausibleEmail(e)).toBe(false);
  });

  it("rejects addresses over 254 chars (RFC 5321)", () => {
    const long = "a".repeat(250) + "@e.io";
    expect(isPlausibleEmail(long)).toBe(false);
  });
});

describe("normalisePhone", () => {
  it.each([
    ["+44 7700 900123", "447700900123"],
    ["07700-900123", "07700900123"],
    ["(0)7700 900 123", "07700900123"],
    ["  +44  7700  900 123  ", "447700900123"],
  ])("strips non-digits from %s", (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });

  it("returns empty string when no digits present", () => {
    expect(normalisePhone("call me!")).toBe("");
  });
});
