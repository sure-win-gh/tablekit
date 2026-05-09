// Idempotency-Key support for v1 write endpoints.
//
// Stripe-style: a client retrying with the same Idempotency-Key (and
// the same API key) gets the original response back instead of a
// duplicate side-effect. Race-safe via a two-phase claim:
//
//   1. INSERT a `claim` row with response_status=null. ON CONFLICT
//      DO NOTHING means only the first concurrent caller wins.
//   2. The winner runs the handler, then UPDATEs the row with the
//      final status + body.
//   3. A concurrent caller that loses the INSERT race SELECTs the
//      existing row. If status is non-null → return cached. If null
//      → return 409 in_flight (the original is still running).
//
// Bucketed per `api_key_id` so two organisations using the same
// idempotency-key value cannot collide.
//
// Trade-off: we do NOT compare request bodies. A client that reuses
// the key with a different body gets the cached response (silent —
// they almost certainly have a bug). Stripe returns 422 in this case;
// we err on the side of "client retries should never accidentally
// surface a different action's result" which is what caching the
// first response achieves. Document in the OpenAPI doc (PR5).

import "server-only";

import { and, eq, isNull, lt, sql } from "drizzle-orm";

import { apiIdempotencyKeys } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

// A claim row whose response_status is still null after this long is
// almost certainly orphaned (handler crashed without the throw-path
// `delete` running, e.g. process killed). After this window we let
// a retry reclaim the slot rather than wait for the 24h sweep —
// otherwise a single crash locks `(api_key_id, key)` for a day.
const CLAIM_STALE_MS = 60 * 1000;

export type IdempotentResponse = {
  status: number;
  body: unknown;
};

export type IdempotencyOutcome =
  | { kind: "ran"; response: IdempotentResponse }
  | { kind: "cached"; response: IdempotentResponse }
  | { kind: "in_flight" };

export async function withIdempotency(
  args: { apiKeyId: string; key: string },
  handler: () => Promise<IdempotentResponse>,
): Promise<IdempotencyOutcome> {
  const db = adminDb();

  // Phase 1: try to claim the (api_key_id, key) slot.
  const claimed = await db
    .insert(apiIdempotencyKeys)
    .values({ apiKeyId: args.apiKeyId, key: args.key })
    .onConflictDoNothing()
    .returning({ apiKeyId: apiIdempotencyKeys.apiKeyId });

  if (claimed.length === 0) {
    // Lost the race. Read the existing row.
    const [existing] = await db
      .select({
        status: apiIdempotencyKeys.responseStatus,
        body: apiIdempotencyKeys.responseBody,
        createdAt: apiIdempotencyKeys.createdAt,
      })
      .from(apiIdempotencyKeys)
      .where(
        and(eq(apiIdempotencyKeys.apiKeyId, args.apiKeyId), eq(apiIdempotencyKeys.key, args.key)),
      )
      .limit(1);
    if (!existing) {
      // Vanishingly unlikely — the row we collided with vanished
      // between the INSERT and the SELECT. Treat as in_flight; the
      // client retry will re-claim cleanly.
      return { kind: "in_flight" };
    }
    if (existing.status === null) {
      // Stale-claim reclaim: if the in-flight row is older than
      // CLAIM_STALE_MS, the original handler almost certainly
      // crashed. Try to atomically delete-then-reclaim; on success
      // we run the handler ourselves. The conditional WHERE makes
      // a concurrent recovery race-safe — only one wiper wins.
      const ageMs = Date.now() - existing.createdAt.getTime();
      if (ageMs >= CLAIM_STALE_MS) {
        const wiped = await db
          .delete(apiIdempotencyKeys)
          .where(
            and(
              eq(apiIdempotencyKeys.apiKeyId, args.apiKeyId),
              eq(apiIdempotencyKeys.key, args.key),
              isNull(apiIdempotencyKeys.responseStatus),
              lt(apiIdempotencyKeys.createdAt, new Date(Date.now() - CLAIM_STALE_MS)),
            ),
          )
          .returning({ apiKeyId: apiIdempotencyKeys.apiKeyId });
        if (wiped.length > 0) {
          // We wiped the orphan. Recurse to re-claim cleanly.
          return withIdempotency(args, handler);
        }
        // Lost the wipe race to another caller — treat as in_flight.
      }
      return { kind: "in_flight" };
    }
    return {
      kind: "cached",
      response: { status: existing.status, body: existing.body },
    };
  }

  // We won the claim. Run the handler, then write the result back.
  // If the handler throws we leave the claim row in its null state —
  // a follow-up retry can re-attempt by treating the null row as
  // in_flight, but that's a degraded state. Better than caching a
  // bogus response. The 24h sweep (future) will reap stale claims.
  let response: IdempotentResponse;
  try {
    response = await handler();
  } catch (err) {
    // Drop the claim so a retry can succeed cleanly. Best-effort.
    await db
      .delete(apiIdempotencyKeys)
      .where(
        and(eq(apiIdempotencyKeys.apiKeyId, args.apiKeyId), eq(apiIdempotencyKeys.key, args.key)),
      )
      .catch(() => undefined);
    throw err;
  }

  await db
    .update(apiIdempotencyKeys)
    .set({
      responseStatus: response.status,
      // sql below to coerce JSONB safely — Drizzle handles this for
      // jsonb columns but be explicit so a future column-type change
      // doesn't silently change the encoding.
      responseBody: sql`${JSON.stringify(response.body)}::jsonb`,
    })
    .where(
      and(eq(apiIdempotencyKeys.apiKeyId, args.apiKeyId), eq(apiIdempotencyKeys.key, args.key)),
    );

  return { kind: "ran", response };
}
