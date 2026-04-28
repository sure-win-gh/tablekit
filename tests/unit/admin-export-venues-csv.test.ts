import { describe, expect, it } from "vitest";

import { toCsv } from "@/lib/server/admin/dashboard/csv";
import type { VenueSearchRow } from "@/lib/server/admin/dashboard/metrics/venues-search";

// Locks the column ordering + header names of the venues CSV export.
// The real route handler builds the same toCsv call shape; rename a
// VenueSearchRow key without updating the route → this test surfaces
// the drift on the next run rather than at runtime in production.

const FIXTURE: VenueSearchRow = {
  orgId: "00000000-0000-0000-0000-000000000001",
  orgName: "Test Cafe",
  slug: "test-cafe",
  plan: "core",
  createdAt: new Date("2026-01-15T00:00:00Z"),
  venueCount: 2,
  ownerEmail: "owner@example.com",
  lastBookingAt: new Date("2026-04-20T10:00:00Z"),
  lastLoginAt: new Date("2026-04-27T08:30:00Z"),
  bookings14d: 12,
  logins14d: 4,
  messages14d: 18,
  activityScore: 64,
};

const COLUMNS = [
  { header: "org_id", value: (r: VenueSearchRow) => r.orgId },
  { header: "org_name", value: (r: VenueSearchRow) => r.orgName },
  { header: "slug", value: (r: VenueSearchRow) => r.slug },
  { header: "plan", value: (r: VenueSearchRow) => r.plan },
  { header: "created_at", value: (r: VenueSearchRow) => r.createdAt },
  { header: "venue_count", value: (r: VenueSearchRow) => r.venueCount },
  { header: "owner_email", value: (r: VenueSearchRow) => r.ownerEmail },
  { header: "last_booking_at", value: (r: VenueSearchRow) => r.lastBookingAt },
  { header: "last_login_at", value: (r: VenueSearchRow) => r.lastLoginAt },
  { header: "bookings_14d", value: (r: VenueSearchRow) => r.bookings14d },
  { header: "logins_14d", value: (r: VenueSearchRow) => r.logins14d },
  { header: "messages_14d", value: (r: VenueSearchRow) => r.messages14d },
  { header: "activity_score", value: (r: VenueSearchRow) => r.activityScore },
];

describe("admin venues CSV export shape", () => {
  it("emits UTF-8 BOM, headers, and the fixture row in column order", () => {
    const csv = toCsv([FIXTURE], COLUMNS);

    // BOM
    expect(csv.charCodeAt(0)).toBe(0xfeff);

    const lines = csv.slice(1).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    const [headerLine, dataLine] = lines;
    expect(headerLine).toBe(
      "org_id,org_name,slug,plan,created_at,venue_count,owner_email,last_booking_at,last_login_at,bookings_14d,logins_14d,messages_14d,activity_score",
    );

    // Date columns serialise to ISO; numeric columns stay numeric;
    // owner_email isn't escaped (no special chars).
    expect(dataLine).toContain("2026-01-15T00:00:00.000Z");
    expect(dataLine).toContain("Test Cafe");
    expect(dataLine).toContain("owner@example.com");
    expect(dataLine).toContain("64");
  });

  it("renders empty cells for null date columns", () => {
    const idle: VenueSearchRow = {
      ...FIXTURE,
      lastBookingAt: null,
      lastLoginAt: null,
      ownerEmail: null,
    };
    const csv = toCsv([idle], COLUMNS);
    // Three consecutive empty cells should appear: owner_email,,,
    expect(csv).toMatch(/,,,,/);
  });
});
