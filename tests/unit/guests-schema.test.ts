// Unit tests for lib/guests/schema.ts — Zod boundary behaviour.
//
// The DB round-trip (upsert dedup, encryption) lives in
// tests/integration/rls-guests.test.ts.

import { describe, expect, it } from "vitest";

import { upsertGuestInput } from "@/lib/guests/schema";

describe("upsertGuestInput", () => {
  it("accepts a minimal valid input", () => {
    const r = upsertGuestInput.safeParse({
      firstName: "Jane",
      email: "jane@example.com",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.firstName).toBe("Jane");
      expect(r.data.lastName).toBe("");
      expect(r.data.email).toBe("jane@example.com");
      expect(r.data.phone).toBeUndefined();
    }
  });

  it("trims and lowercases email", () => {
    const r = upsertGuestInput.safeParse({
      firstName: "Jane",
      email: "  Jane@Example.COM  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("jane@example.com");
  });

  it("trims whitespace from names", () => {
    const r = upsertGuestInput.safeParse({
      firstName: "  Jane  ",
      lastName: "  Doe  ",
      email: "jane@example.com",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.firstName).toBe("Jane");
      expect(r.data.lastName).toBe("Doe");
    }
  });

  it("rejects empty first name", () => {
    const r = upsertGuestInput.safeParse({
      firstName: "   ",
      email: "jane@example.com",
    });
    expect(r.success).toBe(false);
  });

  it("rejects invalid email", () => {
    const r = upsertGuestInput.safeParse({
      firstName: "Jane",
      email: "not-an-email",
    });
    expect(r.success).toBe(false);
  });

  it("accepts UK-style phone numbers", () => {
    for (const phone of [
      "+44 7700 900123",
      "+44 (0)7700-900-123",
      "07700 900 123",
      "07700900123",
    ]) {
      const r = upsertGuestInput.safeParse({
        firstName: "Jane",
        email: "jane@example.com",
        phone,
      });
      expect(r.success, `should accept ${phone}`).toBe(true);
    }
  });

  it("rejects clearly junk phone numbers", () => {
    for (const phone of ["abc", "12"]) {
      const r = upsertGuestInput.safeParse({
        firstName: "Jane",
        email: "jane@example.com",
        phone,
      });
      expect(r.success, `should reject ${phone}`).toBe(false);
    }
  });

  it("rejects oversized inputs", () => {
    const r = upsertGuestInput.safeParse({
      firstName: "J".repeat(200),
      email: "jane@example.com",
    });
    expect(r.success).toBe(false);
  });

  it("accepts marketingConsentAt as a Date", () => {
    const now = new Date();
    const r = upsertGuestInput.safeParse({
      firstName: "Jane",
      email: "jane@example.com",
      marketingConsentAt: now,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.marketingConsentAt).toBe(now);
  });
});
