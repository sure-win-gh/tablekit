// Authentication wrapper for v1 REST API route handlers.
//
// Usage:
//   export const GET = withApiAuth(async ({ req, orgId, keyId }) => {
//     ...
//     return NextResponse.json({ data: ... });
//   });
//
// Responsibilities:
//   1. Resolve the `Authorization: Bearer sk_live_…` header to an
//      organisation_id via lib/api-keys/auth.ts.
//   2. On null → 401 with a uniform `unauthorized` body. Same response
//      whether the header is missing, malformed, unknown, or revoked
//      — operators can't probe the auth shape.
//   3. Per-key rate limit: 600 requests / 60s (10 rps sustained, per
//      docs/specs/public-api.md). Sliding-window via Upstash Redis.
//      Bucket key is `apikey:<keyId>` so two keys in the same org
//      get separate budgets — operators can isolate noisy
//      integrations from each other. On exceed → 429 with
//      Retry-After. On Upstash outage / unconfigured: fail open
//      (the limiter returns ok=true).
//   4. Catch any thrown exception and map to 500 `internal_error`. The
//      original error is intentionally NOT included in the response
//      (could leak internals); we log it server-side via console.error
//      so it lands in Vercel logs / Sentry. Per gdpr.md §Logs the only
//      identifiers safe to surface are orgId + keyId, both correlation
//      handles.

import "server-only";

import type { NextRequest } from "next/server";

import { resolveBearerToken } from "@/lib/api-keys/auth";
import { rateLimit } from "@/lib/public/rate-limit";

import { logRequest } from "./request-log";
import { errorResponse, rateLimitedResponse } from "./responses";

// Per-spec: 600 requests per minute per key (10/s sustained).
const RATE_LIMIT_PER_MIN = 600;
const RATE_WINDOW_SEC = 60;

export type ApiContext = {
  req: NextRequest;
  orgId: string;
  keyId: string;
};

export type ApiHandler = (ctx: ApiContext) => Promise<Response>;

export function withApiAuth(handler: ApiHandler) {
  return async (req: NextRequest): Promise<Response> => {
    const resolved = await resolveBearerToken(req.headers.get("authorization"));
    if (!resolved) {
      return errorResponse("unauthorized", "Invalid or missing API key.");
    }

    const startedAt = performance.now();
    const path = new URL(req.url).pathname;
    const log = (status: number) =>
      logRequest({
        organisationId: resolved.organisationId,
        apiKeyId: resolved.id,
        method: req.method,
        path,
        status,
        latencyMs: performance.now() - startedAt,
      });

    // Per-key sliding-window rate limit. Bucket on keyId (not orgId)
    // so two keys in the same org have independent budgets.
    const rl = await rateLimit(`apikey:${resolved.id}`, RATE_LIMIT_PER_MIN, RATE_WINDOW_SEC);
    if (!rl.ok) {
      void log(429);
      return rateLimitedResponse(rl.retryAfterSec ?? RATE_WINDOW_SEC);
    }

    try {
      const res = await handler({ req, orgId: resolved.organisationId, keyId: resolved.id });
      // Surface budget headers on success so well-behaved clients
      // can self-throttle. Industry convention; not part of the
      // spec's required surface but cheap to add.
      res.headers.set("x-ratelimit-limit", String(RATE_LIMIT_PER_MIN));
      res.headers.set("x-ratelimit-remaining", String(rl.remaining));
      // Fire-and-forget request-log INSERT. Per spec acceptance #6:
      // method, path, org, status, latency. No bodies.
      void log(res.status);
      return res;
    } catch (err) {
      // Bland 500 to the client; structured but PII-redacted log to
      // Sentry/Vercel. We deliberately do NOT include `err.message`
      // — pg/Drizzle constraint errors can echo parameter values
      // (e.g. "Key (email_hash)=(…)=duplicate"), and `notes` is
      // operator-typed free text reachable through this layer. The
      // SQL error CODE + constraint name are enough to triage; if
      // we need more we read the request via Vercel logs by
      // correlation key (orgId + keyId).
      const meta = errorMeta(err);
      console.error("[api/v1] handler failed", {
        orgId: resolved.organisationId,
        keyId: resolved.id,
        ...meta,
      });
      void log(500);
      return errorResponse("internal_error", "An internal error occurred.");
    }
  };
}

function errorMeta(err: unknown): Record<string, string> {
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; code?: unknown; constraint?: unknown };
    return {
      ...(typeof e.name === "string" ? { name: e.name } : {}),
      ...(typeof e.code === "string" ? { code: e.code } : {}),
      ...(typeof e.constraint === "string" ? { constraint: e.constraint } : {}),
    };
  }
  return { name: "Unknown" };
}
