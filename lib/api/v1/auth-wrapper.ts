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
//   3. Catch any thrown exception and map to 500 `internal_error`. The
//      original error is intentionally NOT included in the response
//      (could leak internals); we log it server-side via console.error
//      so it lands in Vercel logs / Sentry. Per gdpr.md §Logs the only
//      identifiers safe to surface are orgId + keyId, both correlation
//      handles.
//
// Rate limiting + request logging hook here in PR3 / PR7 of the
// public-api series (this PR is PR2a).

import "server-only";

import type { NextRequest } from "next/server";

import { resolveBearerToken } from "@/lib/api-keys/auth";

import { errorResponse } from "./responses";

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

    try {
      return await handler({ req, orgId: resolved.organisationId, keyId: resolved.id });
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
