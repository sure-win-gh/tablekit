import { describe, expect, it } from "vitest";

import { sanitiseImportError } from "@/lib/import/runner/sanitise-error";

describe("sanitiseImportError", () => {
  it("returns 'Unknown error.' for unrecognised input", () => {
    expect(sanitiseImportError(undefined)).toBe("Unknown error.");
    expect(sanitiseImportError(null)).toBe("Unknown error.");
    expect(sanitiseImportError(42)).toBe("Unknown error.");
    expect(sanitiseImportError({})).toBe("Unknown error.");
  });

  it("extracts message from an Error instance", () => {
    expect(sanitiseImportError(new Error("connection refused"))).toBe("connection refused");
  });

  it("strips the value half of a Postgres detail tuple", () => {
    const msg = "duplicate key value violates unique constraint (email_hash)=(deadbeefdeadbeef)";
    const out = sanitiseImportError(msg);
    expect(out).not.toContain("deadbeefdeadbeef");
    expect(out).toContain("(email_hash)=(<redacted>)");
  });

  it("redacts email-shaped substrings", () => {
    const out = sanitiseImportError("Resend rejected jane.doe@example.com");
    expect(out).not.toContain("jane.doe@example.com");
    expect(out).toContain("<email>");
  });

  it("redacts long digit runs that look like phone numbers", () => {
    const out = sanitiseImportError("Twilio rejected +44 7700 900123: invalid number");
    expect(out).not.toContain("7700");
    expect(out).toContain("<phone>");
  });

  it("redacts email even when nested inside a Postgres detail tuple", () => {
    const msg = "violates unique constraint (email)=(jane@example.com)";
    const out = sanitiseImportError(msg);
    expect(out).not.toContain("jane@example.com");
  });

  it("truncates messages over 480 chars with an ellipsis", () => {
    const long = "x".repeat(600);
    const out = sanitiseImportError(long);
    expect(out.length).toBeLessThanOrEqual(480);
    expect(out.endsWith("…")).toBe(true);
  });

  it("preserves messages under the cap untouched", () => {
    const msg = "queued job not found";
    expect(sanitiseImportError(msg)).toBe(msg);
  });

  it("redacts a UK postcode", () => {
    const out = sanitiseImportError("address mismatch SW1A 1AA");
    expect(out).not.toContain("SW1A");
    expect(out).toContain("<postcode>");
  });

  it("redacts a UK National Insurance number", () => {
    const out = sanitiseImportError("requester NI: AB123456C");
    expect(out).not.toContain("AB123456C");
    expect(out).toContain("<ni>");
  });

  it("PG detail tuple takes precedence over phone-shaped values inside it (regex order)", () => {
    // Regression: a numeric value inside a (col)=(value) tuple
    // would previously be claimed by PHONE_RE before PG_DETAIL_VALUE_RE
    // had a chance to redact it, leaving a malformed (col)=(<phone>).
    const msg = "violates unique constraint (phone_hash)=(4477900900123)";
    const out = sanitiseImportError(msg);
    expect(out).toContain("(phone_hash)=(<redacted>)");
    expect(out).not.toContain("4477900900123");
    expect(out).not.toContain("<phone>");
  });

  it("PG detail tuple takes precedence over a name in the value position", () => {
    // The value is a name — no other regex would catch it. The
    // structural redaction is what saves us.
    const msg = "violates unique constraint (full_name)=(Jane Smith)";
    const out = sanitiseImportError(msg);
    expect(out).toContain("(full_name)=(<redacted>)");
    expect(out).not.toContain("Jane Smith");
  });
});
