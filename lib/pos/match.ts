// Deterministic guest matching for an incoming POS order.
//
// No plaintext scans (same discipline as guests.md). Precedence:
//   1. email_hash — hash the POS-supplied email with the SAME
//      hashForLookup(value,"email") that populates guests.email_hash, and
//      match within the org.
//   2. phone_hash — same, via hashForLookup(value,"phone") against
//      guests.phone_hash (added in migration 0050 + backfilled).
//   3. booking — tie the settled check to a single booking at the same
//      venue whose service window contains closed_at, and adopt that
//      booking's guest. Conservative: only links when exactly one
//      candidate exists, to avoid mis-attribution.
//   4. else null — an unmatched order (still counted in venue revenue).
//
// For both hash matches: when group CRM is OFF the match is venue-scoped
// (the guest must have a realised booking at this venue — mirrors the
// per-venue guest lens in guests.md / multi-venue.md); when ON, any guest
// in the org matches.

import "server-only";

import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";

import { REALISED_STATUSES } from "@/lib/bookings/realised";
import { bookings, guests } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import { hashForLookup } from "@/lib/security/crypto";

import type { NormalisedOrder } from "./types";

export type MatchMethod = "email_hash" | "phone_hash" | "booking" | "manual";

export type MatchResult = {
  guestId: string | null;
  bookingId: string | null;
  matchMethod: MatchMethod | null;
};

const NO_MATCH: MatchResult = { guestId: null, bookingId: null, matchMethod: null };

// A check is usually settled at the end of the meal; allow a grace window
// after the booking's end so "paid as they left" still links.
const CLOSE_GRACE_MS = 2 * 60 * 60 * 1000; // 2 hours

export type MatchOrderParams = {
  organisationId: string;
  venueId: string;
  order: NormalisedOrder;
  groupCrmEnabled: boolean;
};

export async function matchOrder(params: MatchOrderParams): Promise<MatchResult> {
  const { organisationId, venueId, order, groupCrmEnabled } = params;
  const db = adminDb();

  // 1 — email hash.
  if (order.customerEmail) {
    const emailHash = hashForLookup(order.customerEmail, "email");
    const [guest] = await db
      .select({ id: guests.id })
      .from(guests)
      .where(
        and(
          eq(guests.organisationId, organisationId),
          eq(guests.emailHash, emailHash),
          isNull(guests.erasedAt),
        ),
      )
      .limit(1);

    if (guest && (groupCrmEnabled || (await guestHasVenueBooking(guest.id, venueId)))) {
      return { guestId: guest.id, bookingId: null, matchMethod: "email_hash" };
    }
    // Venue-scoped + no booking at this venue → fall through rather than
    // attributing cross-venue spend.
  }

  // 2 — phone hash.
  if (order.customerPhone) {
    const phoneHash = hashForLookup(order.customerPhone, "phone");
    const [guest] = await db
      .select({ id: guests.id })
      .from(guests)
      .where(
        and(
          eq(guests.organisationId, organisationId),
          eq(guests.phoneHash, phoneHash),
          isNull(guests.erasedAt),
        ),
      )
      .limit(1);

    if (guest && (groupCrmEnabled || (await guestHasVenueBooking(guest.id, venueId)))) {
      return { guestId: guest.id, bookingId: null, matchMethod: "phone_hash" };
    }
  }

  // 3 — booking link (same venue, service window contains closed_at).
  const windowStart = new Date(order.closedAt.getTime() - CLOSE_GRACE_MS);
  const candidates = await db
    .select({ id: bookings.id, guestId: bookings.guestId })
    .from(bookings)
    .where(
      and(
        eq(bookings.venueId, venueId),
        inArray(bookings.status, [...REALISED_STATUSES]),
        lte(bookings.startAt, order.closedAt),
        gte(bookings.endAt, windowStart),
      ),
    )
    .limit(2);

  if (candidates.length === 1 && candidates[0]?.guestId) {
    return { guestId: candidates[0].guestId, bookingId: candidates[0].id, matchMethod: "booking" };
  }

  return NO_MATCH;
}

// Venue-scoped gate for the email match: does this guest have at least one
// realised booking at this venue? Cheap existence check.
async function guestHasVenueBooking(guestId: string, venueId: string): Promise<boolean> {
  const db = adminDb();
  const [row] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.guestId, guestId),
        eq(bookings.venueId, venueId),
        inArray(bookings.status, [...REALISED_STATUSES]),
      ),
    )
    .limit(1);
  return Boolean(row);
}
