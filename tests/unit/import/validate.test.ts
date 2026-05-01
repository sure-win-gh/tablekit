import { describe, expect, it } from "vitest";

import { validateRow } from "@/lib/import/validate";
import type { ColumnMap } from "@/lib/import/types";

const defaultMap: ColumnMap = {
  firstName: "First",
  lastName: "Last",
  email: "Email",
  phone: "Phone",
  notes: "Notes",
};

describe("validateRow — accepts", () => {
  it("a fully-populated, well-formed row", () => {
    const r = validateRow(
      {
        First: "Jane",
        Last: "Doe",
        Email: "Jane@Example.com",
        Phone: "+44 7700 900123",
        Notes: "window seat",
      },
      defaultMap,
      1,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidate).toEqual({
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "447700900123",
      notes: "window seat",
    });
  });

  it("a row with only the required fields", () => {
    const r = validateRow(
      { First: "Jane", Email: "jane@example.com" },
      { firstName: "First", email: "Email" },
      2,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidate.lastName).toBeNull();
    expect(r.candidate.phone).toBeNull();
    expect(r.candidate.notes).toBeNull();
  });

  it("ignores a marketingConsent column even when mapped (always null on import)", () => {
    const r = validateRow(
      { First: "Jane", Email: "jane@example.com", Marketing: "Yes" },
      { firstName: "First", email: "Email", marketingConsent: "Marketing" },
      3,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Nothing leaked into the candidate from the marketingConsent column.
    expect(Object.keys(r.candidate)).not.toContain("marketingConsent");
  });

  it("never lands consent state in a candidate, regardless of column-map permutation (GDPR invariant)", () => {
    // Locks the "consent never imports as granted" rule against any
    // future contributor adding fields to GuestCandidate. The
    // candidate must never carry a key whose name suggests consent.
    const consentLikeRowValues: Record<string, string> = {
      First: "Jane",
      Last: "Doe",
      Email: "jane@example.com",
      Marketing: "Yes",
      Consent: "true",
      Subscribed: "1",
    };
    // Try mapping marketingConsent onto every column in turn — none
    // should plumb through to the candidate.
    for (const header of Object.keys(consentLikeRowValues)) {
      const r = validateRow(
        consentLikeRowValues,
        {
          firstName: "First",
          lastName: "Last",
          email: "Email",
          marketingConsent: header,
        },
        99,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const keys = Object.keys(r.candidate);
      for (const k of keys) {
        expect(k.toLowerCase()).not.toContain("consent");
        expect(k.toLowerCase()).not.toContain("marketing");
        expect(k.toLowerCase()).not.toContain("subscribe");
      }
    }
  });
});

describe("validateRow — rejects", () => {
  it("a row missing firstName", () => {
    const r = validateRow({ Email: "jane@example.com" }, defaultMap, 4);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejected.errors).toContainEqual({
      reason: "missing-required",
      field: "firstName",
    });
  });

  it("a row missing email", () => {
    const r = validateRow({ First: "Jane" }, defaultMap, 5);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejected.errors).toContainEqual({
      reason: "missing-required",
      field: "email",
    });
  });

  it("a row with both required fields missing — surfaces both errors", () => {
    const r = validateRow({ Phone: "07700900123" }, defaultMap, 6);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const reasons = r.rejected.errors.map((e) =>
      e.reason === "missing-required" ? e.field : e.reason,
    );
    expect(reasons).toContain("firstName");
    expect(reasons).toContain("email");
  });

  it("a malformed email", () => {
    const r = validateRow(
      { First: "Jane", Email: "not-an-email" },
      defaultMap,
      7,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejected.errors).toContainEqual({
      reason: "invalid-email",
      value: "not-an-email",
    });
  });

  it("notes that exceed the 1000-char cap", () => {
    const r = validateRow(
      {
        First: "Jane",
        Email: "jane@example.com",
        Notes: "x".repeat(1001),
      },
      defaultMap,
      8,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejected.errors).toContainEqual({
      reason: "field-too-long",
      field: "notes",
      max: 1000,
    });
  });

  it("preserves the raw row in the rejection so the operator's CSV report can show it back", () => {
    const raw = { First: "", Email: "broken" };
    const r = validateRow(raw, defaultMap, 9);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejected.raw).toEqual(raw);
    expect(r.rejected.rowNumber).toBe(9);
  });

  it("treats whitespace-only cells as missing", () => {
    const r = validateRow(
      { First: "   ", Email: "jane@example.com" },
      defaultMap,
      10,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejected.errors).toContainEqual({
      reason: "missing-required",
      field: "firstName",
    });
  });
});
