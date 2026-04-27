// Cross-org venue / organisation search + activity score.
//
// One SQL query: scans organisations, optionally filtered by name /
// slug / venue-name match, with scalar subqueries for venue count,
// owner email, last booking, last login (audit_log 'login.success'),
// and 14-day activity counts.
//
// Activity score (0-100) is a piecewise-linear weighted sum:
//   bookings_14d  : cap 20 → 50 points
//   logins_14d    : cap  5 → 20 points
//   messages_14d  : cap 30 → 30 points
// At-risk threshold (UI) is < 30. Saturation thresholds are deliberately
// modest — most year-1 operators will have low absolute volume.
//
// At ~1k orgs the scalar-subquery fan-out is fine on indexed columns
// (organisation_id is the leading column on the relevant indexes).
// If we ever hit a wall, swap for a materialised view.

import "server-only";

import { sql } from "drizzle-orm";

import type { AdminDb } from "../types";

export type VenueSearchRow = {
  orgId: string;
  orgName: string;
  slug: string;
  plan: string;
  createdAt: Date;
  venueCount: number;
  ownerEmail: string | null;
  lastBookingAt: Date | null;
  lastLoginAt: Date | null;
  bookings14d: number;
  logins14d: number;
  messages14d: number;
  activityScore: number;
};

// pg returns timestamptz columns as Date when going through Drizzle's
// schema-typed query builder, but as ISO strings when going through
// db.execute(sql`...`) — that path doesn't apply the column type
// parser. Accept both shapes; normalise to Date in the mapper below.
type Row = {
  org_id: string;
  org_name: string;
  slug: string;
  plan: string;
  created_at: Date | string;
  venue_count: string | number;
  owner_email: string | null;
  last_booking_at: Date | string | null;
  last_login_at: Date | string | null;
  bookings_14d: string | number;
  logins_14d: string | number;
  messages_14d: string | number;
};

function toDate(v: Date | string | null): Date | null {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
}

function activityScore(b: number, l: number, m: number): number {
  const bookings = Math.min(b / 20, 1) * 50;
  const logins = Math.min(l / 5, 1) * 20;
  const messages = Math.min(m / 30, 1) * 30;
  return Math.round(bookings + logins + messages);
}

export async function searchVenues(
  db: AdminDb,
  query: string,
  limit = 50,
): Promise<VenueSearchRow[]> {
  const q = query.trim();
  const like = `%${q}%`;
  const result = await db.execute<Row>(sql`
    SELECT
      o.id            AS org_id,
      o.name          AS org_name,
      o.slug::text    AS slug,
      o.plan          AS plan,
      o.created_at    AS created_at,
      (SELECT count(*) FROM venues v WHERE v.organisation_id = o.id)
        AS venue_count,
      (SELECT u.email::text
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.organisation_id = o.id AND m.role = 'owner'
        ORDER BY m.created_at ASC
        LIMIT 1)
        AS owner_email,
      (SELECT max(b.created_at) FROM bookings b WHERE b.organisation_id = o.id)
        AS last_booking_at,
      (SELECT max(a.created_at)
         FROM audit_log a
        WHERE a.organisation_id = o.id AND a.action = 'login.success')
        AS last_login_at,
      (SELECT count(*) FROM bookings b
        WHERE b.organisation_id = o.id
          AND b.created_at >= now() - interval '14 days')
        AS bookings_14d,
      (SELECT count(*) FROM audit_log a
        WHERE a.organisation_id = o.id
          AND a.action = 'login.success'
          AND a.created_at >= now() - interval '14 days')
        AS logins_14d,
      (SELECT count(*) FROM messages msg
        WHERE msg.organisation_id = o.id
          AND msg.created_at >= now() - interval '14 days')
        AS messages_14d
    FROM organisations o
    WHERE
      ${q.length === 0
        ? sql`true`
        : sql`(
            o.name ILIKE ${like}
            OR o.slug::text ILIKE ${like}
            OR EXISTS (
              SELECT 1 FROM venues v
              WHERE v.organisation_id = o.id AND v.name ILIKE ${like}
            )
          )`
      }
    ORDER BY o.created_at DESC
    LIMIT ${limit}
  `);

  // node-postgres surfaces COUNT(*) as a JS string for bigint safety;
  // normalise back to number for the typed shape.
  return result.rows.map((r) => {
    const b = Number(r.bookings_14d);
    const l = Number(r.logins_14d);
    const m = Number(r.messages_14d);
    return {
      orgId: r.org_id,
      orgName: r.org_name,
      slug: r.slug,
      plan: r.plan,
      createdAt: toDate(r.created_at) as Date,
      venueCount: Number(r.venue_count),
      ownerEmail: r.owner_email,
      lastBookingAt: toDate(r.last_booking_at),
      lastLoginAt: toDate(r.last_login_at),
      bookings14d: b,
      logins14d: l,
      messages14d: m,
      activityScore: activityScore(b, l, m),
    };
  });
}

// Exported for unit testing without a DB.
export const __activityScore = activityScore;
