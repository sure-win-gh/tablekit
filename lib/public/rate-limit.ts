// Sliding-window rate limiter backed by Upstash Redis.
//
// Upstash exposes a REST API (no node-redis needed). We talk to it via
// `fetch` so the edge runtime can use the same helper. The window is
// implemented as a sorted set keyed by `rl:<bucket>` — one entry per
// request with its timestamp as the score.
//
// If `UPSTASH_REDIS_REST_URL` isn't set we fall through permissively
// (always ok). That's intentional for local dev + CI — otherwise
// every integration test would need an Upstash instance.

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec?: number;
};

export async function rateLimit(
  bucket: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const upstashUrl = process.env["UPSTASH_REDIS_REST_URL"];
  const upstashToken = process.env["UPSTASH_REDIS_REST_TOKEN"];
  // Permissive fallback — no Upstash configured.
  if (!upstashUrl || !upstashToken) {
    return { ok: true, remaining: limit };
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
      // Fail-open on Upstash outage — the UX is worse than the abuse
      // risk for a bootstrap app.
      return { ok: true, remaining: limit };
    }
    const data = (await res.json()) as Array<{ result: number | string }>;
    const zcardEntry = data[2];
    const count = typeof zcardEntry?.result === "number" ? zcardEntry.result : Number(zcardEntry?.result ?? 0);
    const remaining = Math.max(0, limit - count);
    if (count > limit) {
      return { ok: false, remaining: 0, retryAfterSec: windowSec };
    }
    return { ok: true, remaining };
  } catch {
    // Network / timeout → fail open.
    return { ok: true, remaining: limit };
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
