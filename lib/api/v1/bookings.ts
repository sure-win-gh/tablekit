// Read queries for the v1 bookings endpoints.
//
// Always scoped by organisation_id (the auth wrapper resolves this
// from the API key — never trust a query param). Cursor pagination
// orders by (start_at desc, id desc) so consecutive pages don't
// overlap and ties are broken deterministically.
//
// Booking columns are non-PII. The guest_id FK is included in the
// response so callers can fetch /v1/guests/:id when they need contact
// details — this keeps the list endpoint cheap (no per-row decrypt).

import "server-only";

import { and, desc, eq, gte, inArray, isNotNull, lt, lte, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/lib/db/schema";
import { bookings } from "@/lib/db/schema";

import { type Cursor, encodeCursor } from "./cursor";

type Db = NodePgDatabase<typeof schema>;

// Mirrors the booking_status pgEnum at lib/db/schema.ts. Kept as a
// local literal-tuple so we can validate `?status=` query strings
// without importing pgEnum machinery into the API layer.
export const BOOKING_STATUSES = [
  "requested",
  "confirmed",
  "seated",
  "finished",
  "cancelled",
  "no_show",
] as const;
export type BookingStatusLiteral = (typeof BOOKING_STATUSES)[number];

export type ListBookingsArgs = {
  organisationId: string;
  venueId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  status?: ReadonlyArray<BookingStatusLiteral> | undefined;
  cursor?: Cursor<string> | null | undefined;
  limit: number;
};

export type SerialisedBooking = {
  id: string;
  venue_id: string;
  service_id: string;
  guest_id: string;
  party_size: number;
  start_at: string;
  end_at: string;
  status: string;
  source: string;
  notes: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ListBookingsResult = {
  data: SerialisedBooking[];
  next_cursor: string | null;
};

export async function listBookings(db: Db, args: ListBookingsArgs): Promise<ListBookingsResult> {
  // Event-ticket bookings (service_id null, source='event') are a
  // different resource shape — excluded from the standard bookings
  // API rather than breaking the documented `service_id: string`
  // contract. They get their own v1 surface with event reporting
  // (special-events.md §Event revenue reporting).
  const conds = [eq(bookings.organisationId, args.organisationId), isNotNull(bookings.serviceId)];
  if (args.venueId) conds.push(eq(bookings.venueId, args.venueId));
  if (args.from) conds.push(gte(bookings.startAt, args.from));
  if (args.to) conds.push(lte(bookings.startAt, args.to));
  if (args.status && args.status.length > 0) {
    conds.push(inArray(bookings.status, [...args.status]));
  }

  // Keyset pagination: WHERE (start_at, id) < (cursor.k, cursor.i)
  // under DESC ordering. Use a tuple comparison so we get the right
  // tie-break behaviour without two index scans.
  if (args.cursor) {
    conds.push(
      or(
        lt(bookings.startAt, new Date(args.cursor.k)),
        and(eq(bookings.startAt, new Date(args.cursor.k)), lt(bookings.id, args.cursor.i)),
      )!,
    );
  }

  // Fetch limit+1 so we can tell whether there's a next page without
  // a separate count query.
  const rows = await db
    .select({
      id: bookings.id,
      venueId: bookings.venueId,
      serviceId: bookings.serviceId,
      guestId: bookings.guestId,
      partySize: bookings.partySize,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
      source: bookings.source,
      notes: bookings.notes,
      cancelledAt: bookings.cancelledAt,
      createdAt: bookings.createdAt,
      updatedAt: bookings.updatedAt,
    })
    .from(bookings)
    .where(and(...conds))
    .orderBy(desc(bookings.startAt), desc(bookings.id))
    .limit(args.limit + 1);

  // The isNotNull(service_id) condition guarantees this at runtime;
  // the filter only narrows the row type for TS.
  const standard = rows.filter(
    (r): r is (typeof rows)[number] & { serviceId: string } => r.serviceId !== null,
  );

  const hasMore = standard.length > args.limit;
  const page = hasMore ? standard.slice(0, args.limit) : standard;
  const last = page[page.length - 1];
  const next_cursor =
    hasMore && last ? encodeCursor({ k: last.startAt.toISOString(), i: last.id }) : null;

  return { data: page.map(serialise), next_cursor };
}

export async function getBooking(
  db: Db,
  args: { organisationId: string; id: string },
): Promise<SerialisedBooking | null> {
  const [row] = await db
    .select({
      id: bookings.id,
      venueId: bookings.venueId,
      serviceId: bookings.serviceId,
      guestId: bookings.guestId,
      partySize: bookings.partySize,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
      source: bookings.source,
      notes: bookings.notes,
      cancelledAt: bookings.cancelledAt,
      createdAt: bookings.createdAt,
      updatedAt: bookings.updatedAt,
    })
    .from(bookings)
    .where(and(eq(bookings.id, args.id), eq(bookings.organisationId, args.organisationId)))
    .limit(1);
  // Event-ticket bookings are not part of this API surface (see
  // listBookings) — treat them as not found rather than emit a row
  // that violates the `service_id: string` contract.
  if (!row || row.serviceId === null) return null;
  // Spread so the narrowed serviceId re-types the object for TS.
  return serialise({ ...row, serviceId: row.serviceId });
}

function serialise(row: {
  id: string;
  venueId: string;
  serviceId: string;
  guestId: string;
  partySize: number;
  startAt: Date;
  endAt: Date;
  status: string;
  source: string;
  notes: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): SerialisedBooking {
  return {
    id: row.id,
    venue_id: row.venueId,
    service_id: row.serviceId,
    guest_id: row.guestId,
    party_size: row.partySize,
    start_at: row.startAt.toISOString(),
    end_at: row.endAt.toISOString(),
    status: row.status,
    source: row.source,
    notes: row.notes,
    cancelled_at: row.cancelledAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
