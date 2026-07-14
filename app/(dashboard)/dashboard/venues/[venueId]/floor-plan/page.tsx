import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { notFound } from "next/navigation";

import { hasRole } from "@/lib/auth/role-level";
import { requireRole } from "@/lib/auth/require-role";
import { enrichBookingsForDisplay } from "@/lib/bookings/enriched-detail";
import {
  FLOOR_STATE_DOT,
  FLOOR_STATE_LABEL,
  deriveFloorState,
  type FloorTableState,
} from "@/lib/bookings/floor-state";
import { formatVenueTime, todayInZone, venueLocalDayRange } from "@/lib/bookings/time";
import { withUser } from "@/lib/db/client";
import {
  areas,
  bookingTables,
  bookings,
  guests,
  services,
  tableCombinations,
  venueTables,
  venues,
} from "@/lib/db/schema";
import { parseTableCombining } from "@/lib/venues/table-combining";

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
      .select({ id: venues.id, timezone: venues.timezone, settings: venues.settings })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();
  const venueTimezone = venue.timezone;
  const maxCombineTables = parseTableCombining(venue.settings).maxTables;

  const date = todayInZone(venueTimezone);
  const { startUtc, endUtc } = venueLocalDayRange(date, venueTimezone);
  const now = new Date();

  const { areaRows, tableRows, bookingsForDay, assignments, combinationRows } = await withUser(
    async (db) => {
      const [a, t, bRows, combos] = await Promise.all([
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
            guestId: bookings.guestId,
            guestFirstName: guests.firstName,
            serviceName: services.name,
            notes: bookings.notes,
            guestTags: guests.tags,
            guestNotesCipher: guests.notesCipher,
            highChairs: bookings.highChairs,
            dietaryNotesCipher: bookings.dietaryNotesCipher,
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
        db
          .select({
            id: tableCombinations.id,
            areaId: tableCombinations.areaId,
            tableAId: tableCombinations.tableAId,
            tableBId: tableCombinations.tableBId,
          })
          .from(tableCombinations)
          .where(eq(tableCombinations.venueId, venueId)),
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

      return {
        areaRows: a,
        tableRows: t,
        bookingsForDay: bRows,
        assignments: assignmentRows,
        combinationRows: combos,
      };
    },
  );

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

  // Decrypt + count prior visits once for every booking on the day —
  // side-panel renders are constant-time after this batch.
  const enrichmentMap = await withUser(async (db) =>
    enrichBookingsForDisplay(
      db,
      auth.orgId,
      bookingsForDay.map((b) => ({
        id: b.id,
        guestId: b.guestId,
        startAt: b.startAt,
        guestNotesCipher: b.guestNotesCipher,
        dietaryNotesCipher: b.dietaryNotesCipher,
        guestTags: b.guestTags,
        highChairs: b.highChairs,
      })),
    ),
  );

  function buildDetail(bookingId: string, tableId: string): ActiveBookingDetail | null {
    const b = bookingsById.get(bookingId);
    if (!b) return null;
    const allTableIds = assignmentsByBooking.get(bookingId) ?? [];
    const otherTableLabels = allTableIds
      .filter((id) => id !== tableId)
      .map((id) => tableLabelById.get(id))
      .filter((label): label is string => Boolean(label));
    const enrichment = enrichmentMap.get(b.id) ?? {
      guestTags: b.guestTags,
      guestNotes: null,
      dietaryNotes: null,
      highChairs: b.highChairs,
      priorVisits: 0,
    };
    return {
      id: b.id,
      status: b.status,
      partySize: b.partySize,
      guestFirstName: b.guestFirstName,
      serviceName: b.serviceName,
      startWall: formatVenueTime(b.startAt, { timezone: venueTimezone }),
      endWall: formatVenueTime(b.endAt, { timezone: venueTimezone }),
      endAt: b.endAt,
      notes: b.notes,
      otherTableLabels,
      ...enrichment,
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

  // Derive the per-table colour state on the server so the client gets
  // a single map and TableShape doesn't have to recompute. Reads `now`
  // once — the auto-refresh on the canvas re-fetches every 30s.
  const floorStateByTableId: Record<string, FloorTableState> = {};
  for (const t of tableRows) {
    const active = activeByTableId[t.id] ?? null;
    const upcoming = Boolean(upcomingByTableId[t.id]);
    floorStateByTableId[t.id] = deriveFloorState(
      active ? { status: active.status, endAt: active.endAt } : null,
      upcoming,
      now,
    );
  }

  // Live strip for the header — counts by floor state + covers on the
  // floor right now. All derived from maps already built above; multi-
  // table bookings dedupe by booking id so a joined 8-top isn't counted
  // twice.
  const stateCounts: Record<FloorTableState, number> = {
    empty: 0,
    soon: 0,
    confirmed: 0,
    seated: 0,
    overdue: 0,
  };
  for (const t of tableRows) stateCounts[floorStateByTableId[t.id] ?? "empty"] += 1;
  // Seated bookings only — "on the floor" must not count parties whose
  // window covers now but who haven't been seated yet.
  const coversNow = [...new Map(Object.values(activeByTableId).map((b) => [b.id, b])).values()]
    .filter((b) => b.status === "seated")
    .reduce((s, b) => s + b.partySize, 0);
  const stripStates: FloorTableState[] = ["seated", "overdue", "confirmed", "soon", "empty"];

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-ink text-xl font-bold tracking-tight">Floor plan</h2>
          {tableRows.length === 0 ? (
            <p className="text-ash mt-0.5 text-xs">
              No tables yet — switch to edit mode to add areas and tables.
            </p>
          ) : (
            <p className="text-ash mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
              {coversNow > 0 ? (
                <span className="text-ink font-semibold tabular-nums">
                  {coversNow} covers seated now
                </span>
              ) : null}
              {stripStates
                .filter((s) => stateCounts[s] > 0)
                .map((s) => (
                  <span key={s} className="flex items-center gap-1 tabular-nums">
                    <span
                      className={`inline-block h-2 w-2 rounded-sm ${FLOOR_STATE_DOT[s]}`}
                      aria-hidden
                    />
                    {stateCounts[s]} {FLOOR_STATE_LABEL[s].toLowerCase()}
                  </span>
                ))}
              <span className="text-mute">
                updated {formatVenueTime(now, { timezone: venueTimezone })} · refreshes every 30s
              </span>
            </p>
          )}
        </div>
      </header>

      <FloorPlanCanvas
        venueId={venueId}
        date={date}
        canEdit={canEdit}
        areas={canvasAreas}
        tables={canvasTables}
        combinations={combinationRows}
        maxCombineTables={maxCombineTables}
        activeByTableId={activeByTableId}
        upcomingByTableId={upcomingByTableId}
        floorStateByTableId={floorStateByTableId}
      />
    </section>
  );
}
