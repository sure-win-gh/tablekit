// Deposit-rule resolver.
//
// Given a booking context (venue, service, party size, start time),
// picks the single deposit rule that applies — or null if none. The
// resolver is split into two halves:
//
//   rankRules(rules, input) → DepositRule[]   pure
//   resolveRule(input)      → Promise<DepositRule | null>   DB + pure
//
// The pure half does all the deciding; the wrapper only issues a
// venue-scoped SELECT. Unit tests hammer the pure half with synthetic
// fixtures (party-size boundaries, tie-breaks, empty rules, wildcard
// fallback). Integration tests cover the DB path.
//
// Priority order (most specific first). Each criterion is a tiebreaker
// for the previous one:
//
//   1. Rules with a specific service_id match beat wildcard (null) rules.
//   2. Rules with a narrower day_of_week array beat broader ones.
//   3. Rules with a narrower party-size range beat broader ones.
//   4. Most recently created rule wins a tie.
//
// "Narrower" = fewer elements in day_of_week; smaller
// (max_party - min_party) span for party range (unbounded max counts
// as widest).

import "server-only";

import { and, eq, isNull, or, lte, gte, sql } from "drizzle-orm";

import { adminDb } from "@/lib/server/admin/db";
import { depositRules } from "@/lib/db/schema";

export type DepositRule = typeof depositRules.$inferSelect;

export type ResolveRuleInput = {
  venueId: string;
  serviceId: string;
  partySize: number;
  at: Date;
};

// Pure. Exported for unit tests + for any future non-DB caller.
export function rankRules(rules: DepositRule[], input: ResolveRuleInput): DepositRule[] {
  const dow = input.at.getUTCDay(); // 0 = Sunday. DB rules use the same convention.
  const applicable = rules.filter((r) => {
    if (r.venueId !== input.venueId) return false;
    if (r.serviceId !== null && r.serviceId !== input.serviceId) return false;
    if (input.partySize < r.minParty) return false;
    if (r.maxParty !== null && input.partySize > r.maxParty) return false;
    if (!r.dayOfWeek.includes(dow)) return false;
    return true;
  });

  return applicable.sort((a, b) => {
    // 1. service_id match > wildcard
    const aHasService = a.serviceId !== null ? 1 : 0;
    const bHasService = b.serviceId !== null ? 1 : 0;
    if (aHasService !== bHasService) return bHasService - aHasService;

    // 2. narrower day_of_week wins
    if (a.dayOfWeek.length !== b.dayOfWeek.length) {
      return a.dayOfWeek.length - b.dayOfWeek.length;
    }

    // 3. narrower party span wins. Unbounded max counts as widest.
    const aSpan = partySpan(a);
    const bSpan = partySpan(b);
    if (aSpan !== bSpan) return aSpan - bSpan;

    // 4. most recently created wins
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

function partySpan(r: DepositRule): number {
  if (r.maxParty === null) return Number.POSITIVE_INFINITY;
  return r.maxParty - r.minParty;
}

// DB-backed. Returns the single most-specific applicable rule, or null.
export async function resolveRule(input: ResolveRuleInput): Promise<DepositRule | null> {
  // Pre-filter at the DB layer on the cheap predicates. day_of_week
  // filtering uses Postgres array containment; the rest of the priority
  // resolution happens in memory because expressing lexicographic
  // sort with nulls across three columns in Drizzle isn't worth the
  // legibility cost for a rule set that's typically 1–5 rows per venue.
  const dow = input.at.getUTCDay();
  const rows = await adminDb()
    .select()
    .from(depositRules)
    .where(
      and(
        eq(depositRules.venueId, input.venueId),
        or(isNull(depositRules.serviceId), eq(depositRules.serviceId, input.serviceId)),
        lte(depositRules.minParty, input.partySize),
        or(isNull(depositRules.maxParty), gte(depositRules.maxParty, input.partySize)),
        sql`${dow} = ANY(${depositRules.dayOfWeek})`,
      ),
    );
  const ranked = rankRules(rows, input);
  return ranked[0] ?? null;
}
