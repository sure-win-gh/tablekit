// Sliding-window rate limiter backed by Upstash Redis.
//
// Upstash exposes a REST API (no node-redis needed). We talk to it via
// `fetch` so the edge runtime can use the same helper. The window is
// implemented as a sorted set keyed by `rl:<bucket>` — one entry per
// request with its timestamp as the score.
//
// Degraded-mode posture:
//   • Missing Upstash env in PRODUCTION fails closed (blocked, one-time
//     Sentry alert) — a misconfigured prod deploy must not silently run
//     with no app-layer rate limiting. Dev/CI keep the permissive
//     fallback so integration tests don't need an Upstash instance.
//   • Runtime outage (Upstash down / timeout) fails open by default —
//     an Upstash blip must not take down the booking widget — but
//     security-critical buckets (login, signup, password reset, API-key
//     auth) pass `{ failOpen: false }` to fail closed instead.

import { captureMessage } from "@/lib/observability/capture";

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec?: number;
};

export type RateLimitOptions = {
  /**
   * Behaviour when Upstash is configured but unreachable at runtime
   * (outage, timeout, non-2xx). Defaults to true (allow the request).
   * Pass false on buckets where letting traffic through unmetered is
   * worse than blocking legitimate users for one window — credential
   * endpoints and API-key auth.
   */
  failOpen?: boolean;
};

function isProduction(): boolean {
  return (process.env["VERCEL_ENV"] ?? process.env["NODE_ENV"]) === "production";
}

// One alert per lambda instance, not one per request.
let misconfigReported = false;

// Missing env is a deterministic config state (not a blip), so the
// posture doesn't depend on the bucket — production fails closed for
// every caller.
function missingConfigResult(bucket: string, limit: number): RateLimitResult {
  if (isProduction()) {
    if (!misconfigReported) {
      misconfigReported = true;
      captureMessage(
        "rate-limit: UPSTASH_REDIS_REST_URL/TOKEN missing in production — failing closed",
        "error",
        { bucket },
      );
    }
    return { ok: false, remaining: 0, retryAfterSec: 60 };
  }
  return { ok: true, remaining: limit };
}

// Runtime outage: per-bucket posture via opts.failOpen.
function outageResult(
  opts: RateLimitOptions | undefined,
  limit: number,
  windowSec: number,
): RateLimitResult {
  if (opts?.failOpen === false) {
    return { ok: false, remaining: 0, retryAfterSec: windowSec };
  }
  return { ok: true, remaining: limit };
}

export async function rateLimit(
  bucket: string,
  limit: number,
  windowSec: number,
  opts?: RateLimitOptions,
): Promise<RateLimitResult> {
  const upstashUrl = process.env["UPSTASH_REDIS_REST_URL"];
  const upstashToken = process.env["UPSTASH_REDIS_REST_TOKEN"];
  if (!upstashUrl || !upstashToken) {
    return missingConfigResult(bucket, limit);
  }

  const now = Date.now();
  const windowStart = now - windowSec * 1000;
  const key = `rl:${bucket}`;
  const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;

  // Upstash pipeline: drop expired entries, add this one, count, set TTL.
  const pipeline = [
    ["ZREMRANGEBYSCORE", key, "0", String(windowStart)],
    ["ZADD", key, String(now), member],
    ["ZCARD", key],
    ["EXPIRE", key, String(windowSec)],
  ];

  try {
    const res = await fetch(`${upstashUrl}/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${upstashToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(pipeline),
      // Don't leak a rate-limit fetch timeout into the user's request.
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      // Upstash outage — posture is per-bucket (default open: the UX
      // cost of blocking bookings outweighs the abuse risk; credential
      // buckets opt into closed).
      return outageResult(opts, limit, windowSec);
    }
    const data = (await res.json()) as Array<{ result: number | string }>;
    const zcardEntry = data[2];
    const count =
      typeof zcardEntry?.result === "number" ? zcardEntry.result : Number(zcardEntry?.result ?? 0);
    const remaining = Math.max(0, limit - count);
    if (count > limit) {
      return { ok: false, remaining: 0, retryAfterSec: windowSec };
    }
    return { ok: true, remaining };
  } catch {
    // Network / timeout → same per-bucket posture as non-2xx.
    return outageResult(opts, limit, windowSec);
  }
}

/**
 * Read-only check of a bucket's current fill without recording a hit.
 *
 * Use where an attempt should only *count* on failure — the per-account
 * login throttle peeks before auth (blocking once the window is full),
 * then calls `rateLimit` to record a hit only when auth actually fails.
 * That way a member's successful logins never consume their own budget,
 * while credential-stuffing one account still trips at the limit.
 *
 * Same degraded-mode posture as `rateLimit` (missing env fails closed
 * in production; outage posture per-bucket via opts). Blocks at
 * `count >= limit` (whereas `rateLimit` uses `> limit` because it
 * counts after adding the current hit) — both allow exactly `limit`
 * hits per window.
 */
export async function peekRateLimit(
  bucket: string,
  limit: number,
  windowSec: number,
  opts?: RateLimitOptions,
): Promise<RateLimitResult> {
  const upstashUrl = process.env["UPSTASH_REDIS_REST_URL"];
  const upstashToken = process.env["UPSTASH_REDIS_REST_TOKEN"];
  if (!upstashUrl || !upstashToken) {
    return missingConfigResult(bucket, limit);
  }

  const windowStart = Date.now() - windowSec * 1000;
  const key = `rl:${bucket}`;
  const pipeline = [
    ["ZREMRANGEBYSCORE", key, "0", String(windowStart)],
    ["ZCARD", key],
  ];

  try {
    const res = await fetch(`${upstashUrl}/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${upstashToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      return outageResult(opts, limit, windowSec);
    }
    const data = (await res.json()) as Array<{ result: number | string }>;
    const zcardEntry = data[1];
    const count =
      typeof zcardEntry?.result === "number" ? zcardEntry.result : Number(zcardEntry?.result ?? 0);
    if (count >= limit) {
      return { ok: false, remaining: 0, retryAfterSec: windowSec };
    }
    return { ok: true, remaining: Math.max(0, limit - count) };
  } catch {
    return outageResult(opts, limit, windowSec);
  }
}

// Helpful extractor — pulls the client IP from request headers. Works
// behind Cloudflare (`cf-connecting-ip`) and Vercel (`x-forwarded-for`).
// Falls back to a shared "unknown" bucket; callers use that as a last
// resort rather than an excuse to skip limiting.
export function ipFromHeaders(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
