// Unit tests for the pure crypto helpers under lib/outreach/claim-token.ts.
// No DB; the orchestration that USES these helpers is tested via the
// existing integration suite when PR 4b lands.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildClaimUrl,
  CLAIM_DEFAULT_TTL_MS,
  generateClaimToken,
  hashClaimToken,
} from "@/lib/outreach/claim-token";

describe("generateClaimToken", () => {
  it("returns plaintext + matching SHA-256 hex digest", () => {
    const r = generateClaimToken();
    expect(r.token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet
    expect(r.token.length).toBeGreaterThanOrEqual(40);
    const expected = createHash("sha256").update(r.token).digest("hex");
    expect(r.tokenHash).toBe(expected);
  });

  it("produces a unique token across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 256; i++) {
      const { token } = generateClaimToken();
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
  });
});

describe("hashClaimToken", () => {
  it("is deterministic for a given input", () => {
    expect(hashClaimToken("abc")).toBe(hashClaimToken("abc"));
  });

  it("matches the digest a Postgres `digest('sha256', x)` would compute", () => {
    // Postgres pgcrypto's sha256 is the same function — we just check
    // against a known fixture so a future change to encoding (hex vs
    // base64) trips the test.
    expect(hashClaimToken("known")).toBe(
      "7117fff2d0fd294462b3c802b7cb8753579f23f3946b99cf55f38e873f013f10",
    );
  });
});

describe("buildClaimUrl", () => {
  it("joins app URL and token with the canonical /claim/[token] shape", () => {
    expect(buildClaimUrl({ token: "abc123", appUrl: "https://tablekit.app" })).toBe(
      "https://tablekit.app/claim/abc123",
    );
  });

  it("trims trailing slash from appUrl", () => {
    expect(buildClaimUrl({ token: "abc", appUrl: "https://tablekit.app/" })).toBe(
      "https://tablekit.app/claim/abc",
    );
  });

  it("URL-encodes the token", () => {
    expect(buildClaimUrl({ token: "a/b+c=", appUrl: "https://x" })).toBe(
      "https://x/claim/a%2Fb%2Bc%3D",
    );
  });
});

describe("CLAIM_DEFAULT_TTL_MS", () => {
  it("is 30 days so the cron purge window can rely on it", () => {
    expect(CLAIM_DEFAULT_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
