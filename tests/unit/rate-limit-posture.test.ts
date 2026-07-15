// Degraded-mode posture of the Upstash rate limiter.
//
// Two distinct failure classes with different postures:
//   • Missing env (config error): fail closed in production for every
//     bucket; permissive in dev/CI so tests don't need Upstash.
//   • Runtime outage (fetch failure / non-2xx): fail open by default,
//     fail closed when the caller passes { failOpen: false }.
//
// The Sentry seam (lib/observability/capture) is mocked out — these
// tests assert the returned posture, plus the one-alert-per-instance
// debounce on the misconfig path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/capture", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { captureMessage } from "@/lib/observability/capture";

const UPSTASH_ENV = {
  UPSTASH_REDIS_REST_URL: "https://fake-upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "fake-token",
};

// The module keeps instance-level state (the one-time misconfig alert
// flag), so import a fresh copy per test via resetModules + dynamic
// import.
async function freshLimiter() {
  vi.resetModules();
  return import("@/lib/public/rate-limit");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("missing Upstash env", () => {
  it("fails closed in production (rateLimit + peekRateLimit)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const { rateLimit, peekRateLimit } = await freshLimiter();

    const r1 = await rateLimit("t:missing-prod", 10, 60);
    expect(r1.ok).toBe(false);
    expect(r1.retryAfterSec).toBeGreaterThan(0);

    const r2 = await peekRateLimit("t:missing-prod", 10, 60);
    expect(r2.ok).toBe(false);
  });

  it("reports to Sentry once per instance, not once per request", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const { rateLimit } = await freshLimiter();

    await rateLimit("t:alert-a", 10, 60);
    await rateLimit("t:alert-b", 10, 60);
    expect(vi.mocked(captureMessage)).toHaveBeenCalledTimes(1);
  });

  it("stays permissive outside production", async () => {
    vi.stubEnv("VERCEL_ENV", "development");
    const { rateLimit, peekRateLimit } = await freshLimiter();

    expect((await rateLimit("t:missing-dev", 10, 60)).ok).toBe(true);
    expect((await peekRateLimit("t:missing-dev", 10, 60)).ok).toBe(true);
    expect(vi.mocked(captureMessage)).not.toHaveBeenCalled();
  });
});

describe("Upstash runtime outage", () => {
  beforeEach(() => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", UPSTASH_ENV.UPSTASH_REDIS_REST_URL);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", UPSTASH_ENV.UPSTASH_REDIS_REST_TOKEN);
  });

  it("fails open by default when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const { rateLimit, peekRateLimit } = await freshLimiter();

    expect((await rateLimit("t:outage-open", 10, 60)).ok).toBe(true);
    expect((await peekRateLimit("t:outage-open", 10, 60)).ok).toBe(true);
  });

  it("fails closed with { failOpen: false } when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const { rateLimit, peekRateLimit } = await freshLimiter();

    const r1 = await rateLimit("t:outage-closed", 10, 60, { failOpen: false });
    expect(r1.ok).toBe(false);
    expect(r1.retryAfterSec).toBe(60);

    const r2 = await peekRateLimit("t:outage-closed", 10, 60, { failOpen: false });
    expect(r2.ok).toBe(false);
  });

  it("fails closed with { failOpen: false } on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("upstream error", { status: 503 })),
    );
    const { rateLimit } = await freshLimiter();

    const r = await rateLimit("t:5xx-closed", 10, 60, { failOpen: false });
    expect(r.ok).toBe(false);
  });

  it("still enforces the real limit when Upstash responds", async () => {
    // ZCARD says the window already holds `limit` + 1 entries.
    const body = JSON.stringify([{ result: 0 }, { result: 1 }, { result: 11 }, { result: 1 }]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
        ),
    );
    const { rateLimit } = await freshLimiter();

    const r = await rateLimit("t:enforced", 10, 60);
    expect(r.ok).toBe(false);
    expect(r.retryAfterSec).toBe(60);
  });
});
