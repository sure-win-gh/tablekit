// Unit tests for lib/security/crypto.ts.
//
// Scope here is deliberately narrow — the bits of the crypto module
// that don't touch the DB:
//   - hashForLookup (deterministic HMAC, normalisation by kind)
//   - constantTimeEqual
//   - master-key loader error paths
//
// The encrypt/decrypt round-trip and cross-org isolation are exercised
// in tests/integration/rls-crypto.test.ts because they need a real
// organisation row to wrap/unwrap a DEK against.

import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetMasterKeyForTests, constantTimeEqual, hashForLookup } from "@/lib/security/crypto";

describe("crypto — master key loader", () => {
  const originalKey = process.env["TABLEKIT_MASTER_KEY"];

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env["TABLEKIT_MASTER_KEY"];
    } else {
      process.env["TABLEKIT_MASTER_KEY"] = originalKey;
    }
    _resetMasterKeyForTests();
  });

  it("throws when TABLEKIT_MASTER_KEY is missing", () => {
    delete process.env["TABLEKIT_MASTER_KEY"];
    _resetMasterKeyForTests();
    expect(() => hashForLookup("anything")).toThrow(/TABLEKIT_MASTER_KEY is not set/);
  });

  it("throws when the key is the wrong length", () => {
    process.env["TABLEKIT_MASTER_KEY"] = Buffer.from("too-short").toString("base64");
    _resetMasterKeyForTests();
    expect(() => hashForLookup("anything")).toThrow(/must decode to 32 bytes/);
  });
});

describe("crypto — hashForLookup", () => {
  beforeEach(() => {
    // Make sure every test in this block uses the same key (the one
    // loaded from .env.local by tests/unit/setup.ts).
    _resetMasterKeyForTests();
  });

  it("is deterministic for the same input + kind", () => {
    expect(hashForLookup("foo@bar.com", "email")).toBe(hashForLookup("foo@bar.com", "email"));
  });

  it("returns different hashes for different inputs", () => {
    expect(hashForLookup("a@b.com", "email")).not.toBe(hashForLookup("c@d.com", "email"));
  });

  it("normalises email kind: lowercase + trim", () => {
    expect(hashForLookup("  Foo@BAR.com ", "email")).toBe(hashForLookup("foo@bar.com", "email"));
  });

  it("normalises phone kind: strip non-digits", () => {
    expect(hashForLookup("+44 7700 900123", "phone")).toBe(hashForLookup("447700900123", "phone"));
    expect(hashForLookup("+44 (0)7700-900-123", "phone")).toBe(
      hashForLookup("4407700900123", "phone"),
    );
  });

  it("raw kind does not normalise", () => {
    expect(hashForLookup("Foo", "raw")).not.toBe(hashForLookup("foo", "raw"));
  });

  it("defaults to raw when kind omitted", () => {
    expect(hashForLookup("Foo")).toBe(hashForLookup("Foo", "raw"));
  });

  it("produces 64-char hex digests", () => {
    const h = hashForLookup("whatever", "raw");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different kinds of the same string produce different hashes after normalisation", () => {
    // "ABC" as email normalises to "abc"; as raw stays "ABC" —
    // different inputs to the HMAC → different digest.
    expect(hashForLookup("ABC", "email")).not.toBe(hashForLookup("ABC", "raw"));
  });
});

describe("crypto — constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  it("returns false for strings of different lengths (no throw)", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("handles random strings", () => {
    const a = randomBytes(32).toString("hex");
    const b = randomBytes(32).toString("hex");
    expect(constantTimeEqual(a, a)).toBe(true);
    expect(constantTimeEqual(a, b)).toBe(false);
  });
});
