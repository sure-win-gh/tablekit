// Pure helpers for the bookings-list filter URL params.
//
// Lives in lib/ so the unit test can exercise it without booting the
// dashboard route. The page.tsx query and the BookingsFilters client
// component both import from here.

import { BOOKING_STATUSES, type BookingStatus } from "./state";

export type SearchKind =
  | { kind: "empty" }
  | { kind: "email"; raw: string }
  | { kind: "freetext"; pattern: string };

// Heuristic: a query containing `@` is an email; anything else is
// freetext. We don't try regex-validate the email — `@` alone is a
// strong signal in this UI and the email lookup is hash-exact, so a
// non-match just returns no rows.
export function classifySearchInput(raw: string | undefined): SearchKind {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed.includes("@")) return { kind: "email", raw: trimmed };
  // ILIKE pattern with both wildcards. `%` and `_` in user input are
  // treated literally so we don't expose pattern semantics — the
  // performance cost is irrelevant at our row counts.
  const escaped = trimmed.replace(/[\\%_]/g, (c) => `\\${c}`);
  return { kind: "freetext", pattern: `%${escaped}%` };
}

// Parse a comma-separated `status` URL param into a typed list of
// BookingStatus values. Unknown tokens are dropped silently.
export function parseStatusFilter(raw: string | undefined): BookingStatus[] {
  if (!raw) return [];
  const allowed = new Set<string>(BOOKING_STATUSES);
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => allowed.has(s));
  return tokens as BookingStatus[];
}
