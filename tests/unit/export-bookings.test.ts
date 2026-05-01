// Pure shape tests for the bookings-export writer. Mirrors the
// guests sibling — the DB-bound loadBookingsForExport is covered
// in the integration suite.

import { describe, expect, it } from "vitest";

import { type ExportedBooking, bookingsToCsv, bookingsToJson } from "@/lib/export/bookings";

const BOM = "﻿";

const sample: ExportedBooking[] = [
  {
    bookingId: "4e2d1f8a-aaaa-bbbb-cccc-000000000001",
    reference: "4E2D-1F8A",
    venueId: "ffffffff-1111-1111-1111-111111111111",
    venueName: "The Olive Branch",
    serviceName: "Dinner",
    areaName: "Main",
    guestId: "11111111-1111-1111-1111-111111111111",
    guestFirstName: "Jane",
    guestEmail: "jane@example.com",
    partySize: 4,
    startAt: new Date("2026-05-01T19:00:00.000Z"),
    endAt: new Date("2026-05-01T21:00:00.000Z"),
    status: "confirmed",
    source: "widget",
    notes: "window seat please, allergies: nuts",
    cancelledAt: null,
    cancelledReason: null,
    createdAt: new Date("2026-04-20T08:00:00.000Z"),
  },
];

describe("bookingsToCsv", () => {
  it("emits the expected header and one row", () => {
    const out = bookingsToCsv(sample);
    const lines = out.slice(BOM.length).split("\r\n");
    expect(lines[0]).toBe(
      [
        "booking_id",
        "reference",
        "venue_id",
        "venue_name",
        "service_name",
        "area_name",
        "guest_id",
        "guest_first_name",
        "guest_email",
        "party_size",
        "start_at",
        "end_at",
        "status",
        "source",
        "notes",
        "cancelled_at",
        "cancelled_reason",
        "created_at",
      ].join(","),
    );
    // Notes contain a comma → must be quoted.
    expect(lines[1]).toContain('"window seat please, allergies: nuts"');
    // Party size remains numeric (no leading apostrophe even if it
    // happens to start with a digit; guard fires only on string cells
    // beginning with =, +, -, @, tab, or CR).
    expect(lines[1]).toContain(",4,");
  });

  it("guards a hostile notes cell", () => {
    const hostile: ExportedBooking = {
      ...sample[0]!,
      notes: "=cmd|calc",
    };
    const out = bookingsToCsv([hostile]);
    expect(out).toContain(",'=cmd|calc,");
  });
});

describe("bookingsToJson", () => {
  it("round-trips the array via JSON", () => {
    const out = bookingsToJson(sample);
    const parsed = JSON.parse(out) as ExportedBooking[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.reference).toBe("4E2D-1F8A");
    expect(parsed[0]?.partySize).toBe(4);
  });
});
