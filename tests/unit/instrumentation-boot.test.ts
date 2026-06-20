// Unit tests for the Upstash boot tripwire in instrumentation.ts. The rate
// limiter fails open when Upstash is unset, so production boot must flag it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { missingUpstashInProd } from "@/instrumentation";

const SAVED = { ...process.env };

beforeEach(() => {
  process.env = { ...SAVED };
});
afterEach(() => {
  process.env = { ...SAVED };
});

describe("missingUpstashInProd", () => {
  it("returns [] outside production even if Upstash is unset", () => {
    process.env["VERCEL_ENV"] = "preview";
    delete process.env["UPSTASH_REDIS_REST_URL"];
    delete process.env["UPSTASH_REDIS_REST_TOKEN"];
    expect(missingUpstashInProd()).toEqual([]);
  });

  it("flags both missing keys in a production node runtime", () => {
    process.env["VERCEL_ENV"] = "production";
    process.env["NEXT_RUNTIME"] = "nodejs";
    delete process.env["UPSTASH_REDIS_REST_URL"];
    delete process.env["UPSTASH_REDIS_REST_TOKEN"];
    expect(missingUpstashInProd()).toEqual(["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]);
  });

  it("returns [] when both keys are present in production", () => {
    process.env["VERCEL_ENV"] = "production";
    process.env["NEXT_RUNTIME"] = "nodejs";
    process.env["UPSTASH_REDIS_REST_URL"] = "https://x.upstash.io";
    process.env["UPSTASH_REDIS_REST_TOKEN"] = "token";
    expect(missingUpstashInProd()).toEqual([]);
  });

  it("does not fire on the edge runtime (avoids double-alerting)", () => {
    process.env["VERCEL_ENV"] = "production";
    process.env["NEXT_RUNTIME"] = "edge";
    delete process.env["UPSTASH_REDIS_REST_URL"];
    delete process.env["UPSTASH_REDIS_REST_TOKEN"];
    expect(missingUpstashInProd()).toEqual([]);
  });
});
