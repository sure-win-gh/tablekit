import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { notFound } from "next/navigation";

import { hasRole } from "@/lib/auth/role-level";
import { requireRole } from "@/lib/auth/require-role";
import { formatVenueTime, todayInZone, venueLocalDayRange } from "@/lib/bookings/time";
import { withUser } from "@/lib/db/client";
import {
  areas,
  bookingTables,
  bookings,
  guests,
  services,
  venueTables,
  venues,
} from "@/lib/db/schema";

import { AutoRefresh } from "./auto-refresh";
import { FloorPlanCanvas, type CanvasArea, type CanvasTable } from "./canvas";
import type { ActiveBookingDetail } from "./side-panel";

export const metadata = {
  title: "Floor plan · TableKit",
};

const UPCOMING_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export default async function FloorPlanPage({ params }: { params: Promise<{ venueId: string }> }) {
  const auth = await requireRole("host");
  const { venueId } = await params;
  const canEdit = hasRole(auth.role, "manager");

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id, timezone: venues.timezone })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();
  const venueTimezone = venue.timezone;

  const date = todayInZone(venueTimezone);
  const { startUtc, endUtc } = venueLocalDayRange(date, venueTimezone);
  const now = new Date();

  const { areaRows, tableRows, bookingsForDay, assignments } = await withUser(async (db) => {
    const [a, t, bRows] = await Promise.all([
      db
        .select({ id: areas.id, name: areas.name, sort: areas.sort })
        .from(areas)
        .where(eq(areas.venueId, venueId))
        .orderBy(asc(areas.sort), asc(areas.createdAt)),
      db
        .select({
          id: venueTables.id,
          areaId: venueTables.areaId,
          label: venueTables.label,
          minCover: venueTables.minCover,
          maxCover: venueTables.maxCover,
          shape: venueTables.shape,
          position: venueTables.position,
        })
        .from(venueTables)
        .where(eq(venueTables.venueId, venueId))
        .orderBy(asc(venueTables.label)),
      db
        .select({
          id: bookings.id,
          startAt: bookings.startAt,
          endAt: bookings.endAt,
          partySize: bookings.partySize,
          status: bookings.status,
          guestFirstName: guests.firstName,
          serviceName: services.name,
          notes: bookings.notes,
        })
        .from(bookings)
        .innerJoin(services, eq(services.id, bookings.serviceId))
        .innerJoin(guests, eq(guests.id, bookings.guestId))
        .where(
          and(
            eq(bookings.venueId, venueId),
            gte(bookings.startAt, startUtc),
            lt(bookings.startAt, endUtc),
          ),
        ),
    ]);

    const bookingIds = bRows.map((b) => b.id);
    const assignmentRows =
      bookingIds.length === 0
        ? ([] as Array<{ bookingId: string; tableId: string }>)
        : await db
            .select({
              bookingId: bookingTables.bookingId,
              tableId: bookingTables.tableId,
            })
            .from(bookingTables)
            .where(inArray(bookingTables.bookingId, bookingIds));

    return { areaRows: a, tableRows: t, bookingsForDay: bRows, assignments: assignmentRows };
  });

  const tableLabelById = new Map(tableRows.map((t) => [t.id, t.label]));

  // Group assignments by booking to support multi-table booking labels
  // in the side panel. Same booking → multiple table rows.
  const assignmentsByBooking = new Map<string, string[]>();
  for (const a of assignments) {
    const list = assignmentsByBooking.get(a.bookingId) ?? [];
    list.push(a.tableId);
    assignmentsByBooking.set(a.bookingId, list);
  }

  const bookingsById = new Map(bookingsForDay.map((b) => [b.id, b]));

  function buildDetail(bookingId: string, tableId: string): ActiveBookingDetail | null {
    const b = bookingsById.get(bookingId);
    if (!b) return null;
    const allTableIds = assignmentsByBooking.get(bookingId) ?? [];
    const otherTableLabels = allTableIds
      .filter((id) => id !== tableId)
      .map((id) => tableLabelById.get(id))
      .filter((label): label is string => Boolean(label));
    return {
      id: b.id,
      status: b.status,
      partySize: b.partySize,
      guestFirstName: b.guestFirstName,
      serviceName: b.serviceName,
      startWall: formatVenueTime(b.startAt, { timezone: venueTimezone }),
      endWall: formatVenueTime(b.endAt, { timezone: venueTimezone }),
      notes: b.notes,
      otherTableLabels,
    };
  }

  // Active = covers `now`. Upcoming = starts within the next 30 min and
  // no active booking on the same table. Cancelled / no_show drop out
  // of "active" so the table reads as available.
  const activeByTableId: Record<string, ActiveBookingDetail> = {};
  const upcomingByTableId: Record<string, ActiveBookingDetail> = {};
  for (const a of assignments) {
    const b = bookingsById.get(a.bookingId);
    if (!b) continue;
    if (b.status === "cancelled" || b.status === "no_show") continue;
    const start = b.startAt.getTime();
    const end = b.endAt.getTime();
    const t = now.getTime();
    if (start <= t && t < end) {
      const detail = buildDetail(b.id, a.tableId);
      if (detail) activeByTableId[a.tableId] = detail;
    } else if (start > t && start - t <= UPCOMING_WINDOW_MS) {
      // Don't overwrite an already-active booking; keep the soonest
      // upcoming if multiple match.
      const existing = upcomingByTableId[a.tableId];
      if (!existing) {
        const detail = buildDetail(b.id, a.tableId);
        if (detail) upcomingByTableId[a.tableId] = detail;
      }
    }
  }

  const canvasAreas: CanvasArea[] = areaRows.map((a) => ({ id: a.id, name: a.name }));
  const canvasTables: CanvasTable[] = tableRows.map((t) => ({
    id: t.id,
    areaId: t.areaId,
    label: t.label,
    minCover: t.minCover,
    maxCover: t.maxCover,
    shape: t.shape,
    position: t.position as { x: number; y: number; w: number; h: number },
  }));

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-ink text-xl font-bold tracking-tight">Floor plan</h2>
          <p className="text-ash mt-0.5 text-xs">
            {tableRows.length === 0
              ? "No tables yet — switch to edit mode to add areas and tables."
              : `${tableRows.length} table${tableRows.length === 1 ? "" : "s"} across ${areaRows.length} area${areaRows.length === 1 ? "" : "s"}`}
          </p>
        </div>
      </header>

      <FloorPlanCanvas
        venueId={venueId}
        date={date}
        canEdit={canEdit}
        areas={canvasAreas}
        tables={canvasTables}
        activeByTableId={activeByTableId}
        upcomingByTableId={upcomingByTableId}
      />

      <AutoRefresh />
    </section>
  );
}
