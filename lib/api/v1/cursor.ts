// Cursor pagination for v1 list endpoints.
//
// Convention: clients pass `?cursor=<opaque>&limit=<N>`. Response is
// `{ data: [...], next_cursor: string | null }`. Cursor encodes the
// (sort_key, id) of the last row in the previous page so we can do a
// keyset query without OFFSET (which doesn't scale).
//
// We use a tiny base64url-encoded JSON object as the opaque cursor.
// Clients should never parse it — if we change the encoding later,
// old cursors continue to round-trip if we keep the JSON shape
// stable. Invalid cursors are silently treated as "first page" so a
// bad client can't 500 the endpoint.

import "server-only";

import { Buffer } from "node:buffer";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export type Cursor<TKey> = {
  k: TKey; // sort key value of the last row (e.g. ISO timestamp)
  i: string; // tie-breaker id
};

export function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export function decodeCursor<TKey = string>(raw: string | null): Cursor<TKey> | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Cursor<TKey>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.i !== "string" || !("k" in parsed)) return null;
    // If `k` is a string, require it to parse as a valid Date —
    // current keyset usage in lib/api/v1/bookings.ts feeds it
    // through `new Date(k)`, and an `Invalid Date` would silently
    // turn into a no-row predicate rather than a useful error.
    if (typeof parsed.k === "string" && !Number.isFinite(new Date(parsed.k).getTime())) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function encodeCursor<TKey>(cursor: Cursor<TKey>): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
