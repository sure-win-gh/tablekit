// Unit tests for the Upstash boot tripwire in instrumentation.ts. The rate
// limiter fails closed when Upstash is unset in production — every rate-limited
// route returns 429 — so production boot must flag it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { missingUpstashInProdLike } from "@/instrumentation";

const SAVED = { ...process.env };

beforeEach(() => {
  process.env = { ...SAVED };
  // Neutralise any ambient prod-like signal from the runner env.
  delete process.env["VERCEL_ENV"];
  delete process.env["TABLEKIT_ENV"];
});
afterEach(() => {
  process.env = { ...SAVED };
});

describe("missingUpstashInProdLike", () => {
  it("returns [] outside prod-like envs even if Upstash is unset", () => {
    process.env["VERCEL_ENV"] = "preview";
    delete process.env["UPSTASH_REDIS_REST_URL"];
    delete process.env["UPSTASH_REDIS_REST_TOKEN"];
    expect(missingUpstashInProdLike()).toEqual([]);
  });

  it("flags both missing keys in a production node runtime", () => {
    process.env["VERCEL_ENV"] = "production";
    process.env["NEXT_RUNTIME"] = "nodejs";
    delete process.env["UPSTASH_REDIS_REST_URL"];
    delete process.env["UPSTASH_REDIS_REST_TOKEN"];
    expect(missingUpstashInProdLike()).toEqual([
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
    ]);
  });

  it("also fires on staging (TABLEKIT_ENV=staging), not just Vercel production", () => {
    process.env["TABLEKIT_ENV"] = "staging";
    process.env["NEXT_RUNTIME"] = "nodejs";
    delete process.env["VERCEL_ENV"]; // staging is a preview deployment
    delete process.env["UPSTASH_REDIS_REST_URL"];
    delete process.env["UPSTASH_REDIS_REST_TOKEN"];
    expect(missingUpstashInProdLike()).toEqual([
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
    ]);
  });

  it("returns [] when both keys are present in production", () => {
    process.env["VERCEL_ENV"] = "production";
    process.env["NEXT_RUNTIME"] = "nodejs";
    process.env["UPSTASH_REDIS_REST_URL"] = "https://x.upstash.io";
    process.env["UPSTASH_REDIS_REST_TOKEN"] = "token";
    expect(missingUpstashInProdLike()).toEqual([]);
  });

  it("does not fire on the edge runtime (avoids double-alerting)", () => {
    process.env["VERCEL_ENV"] = "production";
    process.env["NEXT_RUNTIME"] = "edge";
    delete process.env["UPSTASH_REDIS_REST_URL"];
    delete process.env["UPSTASH_REDIS_REST_TOKEN"];
    expect(missingUpstashInProdLike()).toEqual([]);
  });
});
