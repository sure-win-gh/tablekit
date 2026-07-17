// Operator-initiated full bookings export — CSV + JSON.
//
// Spec: docs/specs/import-export.md (Export AC #3 — decryption is
// authorised for the owning org). Joins venue / service / area /
// guest names so the operator can read the export without cross-
// referencing other tables. Guest first_name is plaintext; guest
// email is decrypted per-row through decryptPii. RLS scopes the
// SELECT via the `withUser` caller — every row is org-scoped by
// construction (bookings.organisation_id is enforced by trigger and
// the policy gates membership).

import "server-only";

import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/lib/db/schema";
import { areas, bookings, guests, services, specialEvents, venues } from "@/lib/db/schema";
import { bookingReference } from "@/lib/public/captcha";
import { type CsvColumn, toCsv } from "@/lib/reports/csv";
import { type Ciphertext, decryptPii } from "@/lib/security/crypto";

type Db = NodePgDatabase<typeof schema>;

export type ExportedBooking = {
  bookingId: string;
  reference: string;
  venueId: string;
  venueName: string;
  serviceName: string;
  areaName: string;
  guestId: string;
  guestFirstName: string;
  guestEmail: string;
  partySize: number;
  startAt: Date;
  endAt: Date;
  status: string;
  source: string;
  notes: string | null;
  cancelledAt: Date | null;
  cancelledReason: string | null;
  createdAt: Date;
};

export async function loadBookingsForExport(db: Db, orgId: string): Promise<ExportedBooking[]> {
  const rows = await db
    .select({
      id: bookings.id,
      venueId: bookings.venueId,
      venueName: venues.name,
      serviceName: services.name,
      areaName: areas.name,
      eventName: specialEvents.name,
      guestId: bookings.guestId,
      guestFirstName: guests.firstName,
      guestEmailCipher: guests.emailCipher,
      partySize: bookings.partySize,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
      source: bookings.source,
      notes: bookings.notes,
      cancelledAt: bookings.cancelledAt,
      cancelledReason: bookings.cancelledReason,
      createdAt: bookings.createdAt,
    })
    .from(bookings)
    .innerJoin(venues, eq(venues.id, bookings.venueId))
    // Left joins: event-ticket bookings have null service/area (their
    // context is the special event). Inner joins here silently dropped
    // every paid event booking from the export — a GDPR completeness
    // hole (the controller must be able to export all guest records).
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .leftJoin(areas, eq(areas.id, bookings.areaId))
    .leftJoin(specialEvents, eq(specialEvents.id, bookings.eventId))
    .innerJoin(guests, eq(guests.id, bookings.guestId))
    // Defence-in-depth: filter explicitly by orgId on both anchor
    // tables. Bookings RLS is venue-scoped (migration 0013) which
    // spans every org the caller belongs to; guests RLS is org-set
    // scoped. A dual-org user without this filter would join across
    // their other org's data and attempt to decrypt the wrong DEK.
    .where(and(eq(bookings.organisationId, orgId), eq(guests.organisationId, orgId)))
    .orderBy(asc(bookings.startAt));

  const out: ExportedBooking[] = [];
  for (const row of rows) {
    const guestEmail = await decryptPii(orgId, row.guestEmailCipher as Ciphertext);
    out.push({
      bookingId: row.id,
      reference: bookingReference(row.id),
      venueId: row.venueId,
      venueName: row.venueName,
      // Event bookings label the service column with the event's name
      // ("Event: …") so the CSV stays one flat, self-explanatory table.
      serviceName: row.serviceName ?? (row.eventName !== null ? `Event: ${row.eventName}` : ""),
      areaName: row.areaName ?? "",
      guestId: row.guestId,
      guestFirstName: row.guestFirstName,
      guestEmail,
      partySize: row.partySize,
      startAt: row.startAt,
      endAt: row.endAt,
      status: row.status,
      source: row.source,
      notes: row.notes,
      cancelledAt: row.cancelledAt,
      cancelledReason: row.cancelledReason,
      createdAt: row.createdAt,
    });
  }
  return out;
}

export const bookingsCsvColumns: CsvColumn<ExportedBooking>[] = [
  { header: "booking_id", value: (r) => r.bookingId },
  { header: "reference", value: (r) => r.reference },
  { header: "venue_id", value: (r) => r.venueId },
  { header: "venue_name", value: (r) => r.venueName },
  { header: "service_name", value: (r) => r.serviceName },
  { header: "area_name", value: (r) => r.areaName },
  { header: "guest_id", value: (r) => r.guestId },
  { header: "guest_first_name", value: (r) => r.guestFirstName },
  { header: "guest_email", value: (r) => r.guestEmail },
  { header: "party_size", value: (r) => r.partySize },
  { header: "start_at", value: (r) => r.startAt },
  { header: "end_at", value: (r) => r.endAt },
  { header: "status", value: (r) => r.status },
  { header: "source", value: (r) => r.source },
  { header: "notes", value: (r) => r.notes },
  { header: "cancelled_at", value: (r) => r.cancelledAt },
  { header: "cancelled_reason", value: (r) => r.cancelledReason },
  { header: "created_at", value: (r) => r.createdAt },
];

export function bookingsToCsv(rows: ExportedBooking[]): string {
  return toCsv(rows, bookingsCsvColumns);
}

export function bookingsToJson(rows: ExportedBooking[]): string {
  return JSON.stringify(rows, null, 2);
}
