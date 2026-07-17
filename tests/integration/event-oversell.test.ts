// Oversell-safety test for event ticketing (docs/specs/special-events.md
// Phase 2). This is the one genuinely novel invariant: the atomic conditional
// UPDATE on event_ticket_types.quantity_sold — the reservation that
// createEventBooking runs inside its transaction — must never let more tickets
// sell than exist, no matter how many buyers race.
//
// We exercise the reservation SQL directly (no Stripe, no bookings) because the
// guard IS the DB conditional update + row locking. N concurrent buyers each
// try to reserve one ticket against a capacity of M < N; exactly M must win and
// quantity_sold must land on exactly the cap.

import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

const CAPACITY = 5; // M
const BUYERS = 25; // N > M

// A pool big enough for real concurrency on the reservation row.
const pool = new Pool({ connectionString: process.env["DATABASE_URL"], max: BUYERS });
const db: Db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const run = Date.now().toString(36);
const email = `oversell-${run}@tablekit.test`;

let ctx: {
  userId: string;
  orgId: string;
  venueId: string;
  eventId: string;
  ticketTypeId: string;
};

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const userId = data.user.id;

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Oversell Org ${run}`, slug: `oversell-${run}` })
    .returning({ id: schema.organisations.id });
  if (!org) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values({ userId, organisationId: org.id, role: "owner" });

  const [venue] = await db
    .insert(schema.venues)
    .values({ organisationId: org.id, name: `Oversell Venue ${run}`, venueType: "restaurant" })
    .returning({ id: schema.venues.id });
  if (!venue) throw new Error("venue insert returned no row");

  const [event] = await db
    .insert(schema.specialEvents)
    .values({
      organisationId: org.id,
      venueId: venue.id,
      slug: `oversell-event-${run}`,
      name: `Oversell Event ${run}`,
      startsAt: new Date("2026-11-21T00:00:00Z"),
      endsAt: new Date("2026-11-22T00:00:00Z"),
      status: "published",
      blockScope: "whole_day",
    })
    .returning({ id: schema.specialEvents.id });
  if (!event) throw new Error("event insert returned no row");

  const [ticketType] = await db
    .insert(schema.eventTicketTypes)
    .values({
      organisationId: org.id,
      eventId: event.id,
      name: "Standard",
      priceMinor: 4500,
      quantityTotal: CAPACITY,
      maxPerOrder: 10,
    })
    .returning({ id: schema.eventTicketTypes.id });
  if (!ticketType) throw new Error("ticket type insert returned no row");

  ctx = {
    userId,
    orgId: org.id,
    venueId: venue.id,
    eventId: event.id,
    ticketTypeId: ticketType.id,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userId).catch(() => undefined);
    // Org cascade cleans venue → special_events → event_ticket_types.
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

// The exact reservation the purchase flow runs: increment quantity_sold by 1
// only if it stays within capacity. Returns true iff this buyer got a ticket.
async function reserveOne(): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const reserved = await tx
        .update(schema.eventTicketTypes)
        .set({ quantitySold: sql`${schema.eventTicketTypes.quantitySold} + 1` })
        .where(
          and(
            eq(schema.eventTicketTypes.id, ctx.ticketTypeId),
            sql`${schema.eventTicketTypes.quantitySold} + 1 <= ${schema.eventTicketTypes.quantityTotal}`,
          ),
        )
        .returning({ id: schema.eventTicketTypes.id });
      return reserved.length > 0;
    });
  } catch {
    // A serialization / lock error counts as "did not get a ticket".
    return false;
  }
}

describe("event ticketing — oversell safety", () => {
  it("exactly CAPACITY of N concurrent buyers succeed; quantity_sold lands on the cap", async () => {
    const results = await Promise.all(Array.from({ length: BUYERS }, () => reserveOne()));
    const succeeded = results.filter(Boolean).length;

    expect(succeeded).toBe(CAPACITY);

    const [row] = await db
      .select({
        sold: schema.eventTicketTypes.quantitySold,
        total: schema.eventTicketTypes.quantityTotal,
      })
      .from(schema.eventTicketTypes)
      .where(eq(schema.eventTicketTypes.id, ctx.ticketTypeId));

    expect(row?.sold).toBe(CAPACITY);
    expect(row?.total).toBe(CAPACITY);
    // Never oversold, never negative.
    expect(row!.sold).toBeLessThanOrEqual(row!.total);
    expect(row!.sold).toBeGreaterThanOrEqual(0);
  });
});
