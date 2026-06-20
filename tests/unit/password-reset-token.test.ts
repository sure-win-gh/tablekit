// Unit tests for the pure password-reset helpers (no DB). The mint/resolve/
// consume DB logic is covered by tests/integration/password-reset.test.ts.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildResetUrl, hashResetToken } from "@/lib/auth/password-reset";

describe("hashResetToken", () => {
  it("is a deterministic SHA-256 hex of the token", () => {
    const token = "abc123";
    const expected = createHash("sha256").update(token).digest("hex");
    expect(hashResetToken(token)).toBe(expected);
    expect(hashResetToken(token)).toBe(hashResetToken(token));
  });

  it("differs for different tokens", () => {
    expect(hashResetToken("one")).not.toBe(hashResetToken("two"));
  });

  it("never returns the plaintext", () => {
    const token = "super-secret-token";
    expect(hashResetToken(token)).not.toContain(token);
  });
});

describe("buildResetUrl", () => {
  it("builds the reset URL with the token in the query", () => {
    expect(buildResetUrl({ token: "tok", appUrl: "https://app.tablekit.uk" })).toBe(
      "https://app.tablekit.uk/reset-password?token=tok",
    );
  });

  it("strips a trailing slash from appUrl", () => {
    expect(buildResetUrl({ token: "tok", appUrl: "https://app.tablekit.uk/" })).toBe(
      "https://app.tablekit.uk/reset-password?token=tok",
    );
  });

  it("url-encodes the token", () => {
    expect(buildResetUrl({ token: "a/b+c=", appUrl: "https://x.test" })).toBe(
      "https://x.test/reset-password?token=a%2Fb%2Bc%3D",
    );
  });
});
