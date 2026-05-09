// Unit tests for webhook HMAC signing.

import { describe, expect, it } from "vitest";

import { signBody, verifySignature } from "@/lib/webhooks/sign";

describe("signBody", () => {
  it("returns sha256=<64 hex chars>", () => {
    const sig = signBody("secret", "{}");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("is deterministic for the same secret + body", () => {
    expect(signBody("s", "abc")).toBe(signBody("s", "abc"));
  });

  it("differs across secrets", () => {
    expect(signBody("a", "{}")).not.toBe(signBody("b", "{}"));
  });

  it("differs across bodies", () => {
    expect(signBody("s", "{}")).not.toBe(signBody("s", "[]"));
  });
});

describe("verifySignature", () => {
  it("accepts a matching signature", () => {
    const body = '{"a":1}';
    const sig = signBody("secret", body);
    expect(verifySignature("secret", body, sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = signBody("secret", '{"a":1}');
    expect(verifySignature("secret", '{"a":2}', sig)).toBe(false);
  });

  it("rejects under the wrong secret", () => {
    const sig = signBody("right", '{"a":1}');
    expect(verifySignature("wrong", '{"a":1}', sig)).toBe(false);
  });

  it("rejects malformed signatures without crashing", () => {
    expect(verifySignature("secret", '{"a":1}', "garbage")).toBe(false);
  });
});
