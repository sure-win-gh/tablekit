// Per-org drill-down for the admin /admin/venues/[orgId] page.
//
// Returns the org row + venues + members + 30-day activity counts +
// Stripe Connect status. NO decryption of guest PII — every count is
// an aggregate over indexed columns; member emails are users.email
// (operator-side, plaintext-stored for login).
//
// Returns null if the orgId doesn't exist (renders a 404 in the page).

import "server-only";

import { and, count, desc, eq, gte, sql } from "drizzle-orm";

import {
  bookings,
  memberships,
  messages,
  organisations,
  payments,
  stripeAccounts,
  users,
  venues,
} from "@/lib/db/schema";

import { lastNDays } from "../filter";
import type { AdminDb } from "../types";

export type OrgDetail = {
  org: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    createdAt: Date;
    stripeCustomerId: string | null;
  };
  venues: { id: string; name: string; venueType: string; timezone: string; createdAt: Date }[];
  members: { userId: string; email: string; role: string; createdAt: Date }[];
  counts30d: { bookings: number; messages: number; paymentsSucceeded: number };
  // 30-day booking-creation trend for the drill-down chart.
  bookingsByDay: { day: string; n: number }[];
  stripeConnect: {
    accountId: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
  } | null;
};

export async function getOrgDetail(db: AdminDb, orgId: string): Promise<OrgDetail | null> {
  const bounds = lastNDays(30);

  const [org] = await db
    .select({
      id: organisations.id,
      name: organisations.name,
      slug: sql<string>`${organisations.slug}::text`,
      plan: organisations.plan,
      createdAt: organisations.createdAt,
      stripeCustomerId: organisations.stripeCustomerId,
    })
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);
  if (!org) return null;

  const [
    venueRows,
    memberRows,
    bookings30d,
    messages30d,
    paymentsSucceeded30d,
    bookingsByDayRes,
    connect,
  ] = await Promise.all([
    db
      .select({
        id: venues.id,
        name: venues.name,
        venueType: venues.venueType,
        timezone: venues.timezone,
        createdAt: venues.createdAt,
      })
      .from(venues)
      .where(eq(venues.organisationId, orgId))
      .orderBy(desc(venues.createdAt)),
    db
      .select({
        userId: users.id,
        email: sql<string>`${users.email}::text`,
        role: memberships.role,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organisationId, orgId))
      .orderBy(memberships.createdAt),
    db
      .select({ n: count() })
      .from(bookings)
      .where(and(eq(bookings.organisationId, orgId), gte(bookings.createdAt, bounds.fromUtc))),
    db
      .select({ n: count() })
      .from(messages)
      .where(and(eq(messages.organisationId, orgId), gte(messages.createdAt, bounds.fromUtc))),
    db
      .select({ n: count() })
      .from(payments)
      .where(
        and(
          eq(payments.organisationId, orgId),
          eq(payments.status, "succeeded"),
          gte(payments.createdAt, bounds.fromUtc),
        ),
      ),
    // Same generate_series gap-fill as the platform-wide bucket
    // queries, scoped to one org.
    db.execute<{ day: string; n: string | number }>(sql`
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(c.n, 0)::int AS n
        FROM generate_series(
          date_trunc('day', ${bounds.fromUtc}::timestamptz at time zone 'UTC')::date,
          date_trunc('day', ${bounds.toUtc}::timestamptz at time zone 'UTC')::date,
          '1 day'::interval
        ) AS d(day)
        LEFT JOIN (
          SELECT date_trunc('day', created_at at time zone 'UTC')::date AS bucket, count(*)::int AS n
          FROM bookings
          WHERE organisation_id = ${orgId}
            AND created_at >= ${bounds.fromUtc} AND created_at <= ${bounds.toUtc}
          GROUP BY 1
        ) c ON c.bucket = d.day
        ORDER BY d.day
      `),
    db
      .select({
        accountId: stripeAccounts.accountId,
        chargesEnabled: stripeAccounts.chargesEnabled,
        payoutsEnabled: stripeAccounts.payoutsEnabled,
        detailsSubmitted: stripeAccounts.detailsSubmitted,
      })
      .from(stripeAccounts)
      .where(eq(stripeAccounts.organisationId, orgId))
      .limit(1),
  ]);

  return {
    org: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan,
      createdAt: org.createdAt,
      stripeCustomerId: org.stripeCustomerId,
    },
    venues: venueRows,
    members: memberRows,
    counts30d: {
      bookings: bookings30d[0]?.n ?? 0,
      messages: messages30d[0]?.n ?? 0,
      paymentsSucceeded: paymentsSucceeded30d[0]?.n ?? 0,
    },
    bookingsByDay: bookingsByDayRes.rows.map((r) => ({ day: r.day, n: Number(r.n) })),
    stripeConnect: connect[0] ?? null,
  };
}
