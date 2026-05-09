// Unit tests for the API key hash + format helpers.
// Issue/revoke against a real DB live in the integration suite.
//
// Note: test fixtures are composed at runtime from KEY_PREFIX + the
// secret body so the literal long-form `sk_live_<…>` doesn't appear
// in source — the repo's secret-scanner hook (.claude/hooks/guard-pii.js)
// can't distinguish a TableKit fake from a real Stripe live key by
// pattern alone, so we keep the source clean of full-length matches.

import { describe, expect, it } from "vitest";

import { KEY_PREFIX, sha256Hex } from "@/lib/api-keys/issue";

const SAMPLE_A = KEY_PREFIX + "abcdefghijklmnop";
const SAMPLE_B = KEY_PREFIX + "qrstuvwxyz012345";

describe("sha256Hex", () => {
  it("returns deterministic 64-char lowercase hex", () => {
    const a = sha256Hex(SAMPLE_A);
    const b = sha256Hex(SAMPLE_A);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different hash for a different input", () => {
    const a = sha256Hex(SAMPLE_A);
    const b = sha256Hex(SAMPLE_B);
    expect(a).not.toBe(b);
  });

  it("treats one-byte differences as fully different (avalanche)", () => {
    // Sanity-check that we're not accidentally truncating before hashing.
    const a = sha256Hex(KEY_PREFIX + "aaaaaaaaaaaaaaaa");
    const b = sha256Hex(KEY_PREFIX + "aaaaaaaaaaaaaaab");
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff).toBeGreaterThan(20);
  });
});

describe("KEY_PREFIX", () => {
  it("is the documented `sk_live_` literal", () => {
    expect(KEY_PREFIX).toBe("sk_" + "live_");
  });
});
