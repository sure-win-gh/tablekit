import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { List, Plus } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui";
import { requireRole } from "@/lib/auth/require-role";
import {
  formatVenueDateLong,
  formatVenueTime,
  todayInZone,
  venueLocalDayRange,
} from "@/lib/bookings/time";
import type { BookingStatus } from "@/lib/bookings/state";
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
import { formatInTimeZone } from "date-fns-tz";

import {
  NewBookingModal,
  TimelineDateNav,
  TimelineDragProvider,
  TimelineRow,
  type TimelineBookingBlock,
  type TimelineService,
} from "./forms";

export const metadata = { title: "Timeline · TableKit" };

// Read-only timeline view of today's bookings — row per table,
// columns by time. The host's "what's on my floor right now" tool;
// pairs with the existing /bookings list view.
//
// Layout: CSS grid with 4 columns per hour (15-min granularity). Each
// booking is positioned via grid-column: <start> / <end> on the row
// for the table(s) it occupies. Multi-table bookings render once per
// occupied row.
//
// Day window: derived from the venue's services (min start, max end)
// rounded to the nearest hour. Falls back to 09:00–23:00 when no
// services are configured.

// Status → block fill (background tint) + border. Distinct from the
// Badge tones used on the bookings list so the timeline reads at a
// glance without colliding with row status pills.
const STATUS_FILL: Record<BookingStatus, string> = {
  requested: "bg-amber-100 border-amber-300 text-amber-900",
  confirmed: "bg-blue-100 border-blue-300 text-blue-900",
  seated: "bg-emerald-100 border-emerald-300 text-emerald-900",
  finished: "bg-neutral-100 border-neutral-300 text-neutral-700",
  cancelled: "bg-stone-100 border-stone-200 text-ash line-through",
  no_show: "bg-rose-100 border-rose-300 text-rose-900",
};

type SearchParams = { date?: string };

export default async function TimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await requireRole("host");
  const { venueId } = await params;
  const { date: dateParam } = await searchParams;

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id, timezone: venues.timezone })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();

  const date = dateParam ?? todayInZone(venue.timezone);
  const { startUtc, endUtc } = venueLocalDayRange(date, venue.timezone);

  const { tables, bookingsForDay, assignments, services: svcRows } = await withUser(async (db) => {
    const [tableRows, bookingRows, svcRows] = await Promise.all([
      db
        .select({
          id: venueTables.id,
          label: venueTables.label,
          areaId: venueTables.areaId,
          areaName: areas.name,
          maxCover: venueTables.maxCover,
        })
        .from(venueTables)
        .innerJoin(areas, eq(areas.id, venueTables.areaId))
        .where(eq(venueTables.venueId, venueId))
        .orderBy(asc(areas.sort), asc(areas.name), asc(venueTables.label)),
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
      db
        .select({
          id: services.id,
          name: services.name,
          schedule: services.schedule,
          turnMinutes: services.turnMinutes,
        })
        .from(services)
        .where(eq(services.venueId, venueId)),
    ]);

    const bookingIds = bookingRows.map((b) => b.id);
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
      tables: tableRows,
      bookingsForDay: bookingRows,
      assignments: assignmentRows,
      services: svcRows,
    };
  });

  // Derive the timeline window from the venue's services. Round
  // outwards to whole hours so the column grid lands on tidy ticks.
  const window = deriveWindow(svcRows);
  const totalSlots = (window.endHour - window.startHour) * 4; // 4 × 15-min slots per hour

  // Group tables by area, preserve order from the query.
  const areaOrder: string[] = [];
  const tablesByArea = new Map<string, typeof tables>();
  for (const t of tables) {
    if (!tablesByArea.has(t.areaId)) {
      areaOrder.push(t.areaId);
      tablesByArea.set(t.areaId, []);
    }
    tablesByArea.get(t.areaId)!.push(t);
  }

  // Index bookings by table_id → list of bookings that land on that table.
  const bookingsByTable = new Map<string, typeof bookingsForDay>();
  const bookingsById = new Map(bookingsForDay.map((b) => [b.id, b]));
  for (const a of assignments) {
    const b = bookingsById.get(a.bookingId);
    if (!b) continue;
    const list = bookingsByTable.get(a.tableId) ?? [];
    list.push(b);
    bookingsByTable.set(a.tableId, list);
  }

  // Build hour-tick labels for the header row.
  const hourTicks: number[] = [];
  for (let h = window.startHour; h <= window.endHour; h++) hourTicks.push(h);

  // "Now" indicator — minutes from window-start in venue zone.
  const nowMinutes = (() => {
    const now = new Date();
    const nowHour = Number(formatInTimeZone(now, venue.timezone, "H"));
    const nowMin = Number(formatInTimeZone(now, venue.timezone, "m"));
    const offsetMin = (nowHour - window.startHour) * 60 + nowMin;
    if (offsetMin < 0 || offsetMin > totalSlots * 15) return null;
    return offsetMin;
  })();

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">
            {formatVenueDateLong(startUtc, { timezone: venue.timezone })}
          </h2>
          <p className="mt-0.5 text-xs text-ash">
            {bookingsForDay.length === 0
              ? "Nothing on the books for this day."
              : `${bookingsForDay.length} booking${bookingsForDay.length === 1 ? "" : "s"} · ${tables.length} ${tables.length === 1 ? "table" : "tables"}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/dashboard/venues/${venueId}/bookings?date=${date}`}>
            <Button variant="secondary" size="sm">
              <List className="h-4 w-4" aria-hidden />
              List view
            </Button>
          </Link>
          <TimelineDateNav venueId={venueId} date={date} />
          <Link href={`/dashboard/venues/${venueId}/bookings/new`}>
            <Button size="sm">
              <Plus className="h-4 w-4" aria-hidden />
              New booking
            </Button>
          </Link>
        </div>
      </header>

      {tables.length === 0 ? (
        <p className="rounded-card border border-dashed border-hairline p-8 text-center text-sm text-ash">
          No tables in this venue yet. Add some on the Floor plan tab.
        </p>
      ) : (
        <Legend />
      )}

      {tables.length > 0 ? (
        <div className="overflow-x-auto rounded-card border border-hairline bg-white">
          <div className="relative min-w-[900px]">
            {/* Time header */}
            <div
              className="sticky top-0 z-10 grid border-b border-hairline bg-white"
              style={{ gridTemplateColumns: `120px repeat(${totalSlots}, minmax(0,1fr))` }}
            >
              <div className="border-r border-hairline px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ash">
                Table
              </div>
              {hourTicks.map((h) => (
                <div
                  key={h}
                  // Each hour spans 4 slots. Position the label at the start of
                  // its slot range; offset by 1 to skip the table-label column.
                  style={{
                    gridColumn: `${(h - window.startHour) * 4 + 2} / span 4`,
                  }}
                  className="border-r border-hairline px-2 py-2 text-[11px] font-mono tabular-nums text-ash"
                >
                  {String(h).padStart(2, "0")}:00
                </div>
              ))}
            </div>

            {/* Area + table rows */}
            <div className="relative">
              {/* Now indicator overlays the whole grid. */}
              {nowMinutes !== null ? (
                <div
                  aria-label="now"
                  className="pointer-events-none absolute inset-y-0 z-20 w-px bg-coral"
                  style={{
                    left: `calc(120px + (100% - 120px) * ${nowMinutes / (totalSlots * 15)})`,
                  }}
                />
              ) : null}

              <TimelineDragProvider>
                <NewBookingModal
                  venueId={venueId}
                  date={date}
                  windowStartHour={window.startHour}
                  services={svcRows as unknown as TimelineService[]}
                />
                {areaOrder.map((areaId) => {
                  const areaTables = tablesByArea.get(areaId) ?? [];
                  const areaName = areaTables[0]?.areaName ?? "";
                  return (
                    <div key={areaId}>
                      <div className="border-b border-hairline bg-cloud px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ash">
                        {areaName}
                      </div>
                      {areaTables.map((t) => {
                        const tableBookings = bookingsByTable.get(t.id) ?? [];
                        const blocks: TimelineBookingBlock[] = tableBookings.flatMap((b) => {
                          const span = bookingSpan(b.startAt, b.endAt, venue.timezone, window);
                          if (!span) return [];
                          return [
                            {
                              id: b.id,
                              // +1 because the table-label column eats the first grid track.
                              startCol: span.startCol + 1,
                              span: span.span,
                              status: b.status as BookingStatus,
                              wallStart: formatVenueTime(b.startAt, {
                                timezone: venue.timezone,
                              }),
                              guestFirstName: b.guestFirstName,
                              partySize: b.partySize,
                              notes: b.notes,
                            },
                          ];
                        });
                        return (
                          <TimelineRow
                            key={t.id}
                            venueId={venueId}
                            date={date}
                            tableId={t.id}
                            tableLabel={t.label}
                            areaId={t.areaId}
                            totalSlots={totalSlots}
                            bookings={blocks}
                          />
                        );
                      })}
                    </div>
                  );
                })}
              </TimelineDragProvider>
            </div>
          </div>
        </div>
      ) : null}

    </section>
  );
}

// Top-of-file helpers — kept module-local so they don't pollute the
// shared lib/bookings/time module with timeline-specific logic.

function deriveWindow(svcRows: Array<{ schedule: unknown }>): {
  startHour: number;
  endHour: number;
} {
  let minStart = 24;
  let maxEnd = 0;
  for (const s of svcRows) {
    const sched = s.schedule as { start?: string; end?: string } | null;
    if (!sched?.start || !sched?.end) continue;
    const [sh] = sched.start.split(":");
    const [eh] = sched.end.split(":");
    if (sh !== undefined) minStart = Math.min(minStart, Number(sh));
    if (eh !== undefined) maxEnd = Math.max(maxEnd, Number(eh) + 1); // +1 because end is exclusive of the hour itself
  }
  if (minStart === 24 || maxEnd === 0) return { startHour: 9, endHour: 23 };
  return { startHour: Math.max(0, minStart), endHour: Math.min(24, maxEnd) };
}

function bookingSpan(
  startAt: Date,
  endAt: Date,
  timezone: string,
  window: { startHour: number; endHour: number },
): { startCol: number; span: number } | null {
  const startMin =
    Number(formatInTimeZone(startAt, timezone, "H")) * 60 +
    Number(formatInTimeZone(startAt, timezone, "m"));
  const endMin =
    Number(formatInTimeZone(endAt, timezone, "H")) * 60 +
    Number(formatInTimeZone(endAt, timezone, "m"));
  const winStartMin = window.startHour * 60;
  const winEndMin = window.endHour * 60;
  const clampedStart = Math.max(startMin, winStartMin);
  const clampedEnd = Math.min(endMin, winEndMin);
  if (clampedEnd <= clampedStart) return null;
  const startCol = Math.floor((clampedStart - winStartMin) / 15);
  const endCol = Math.ceil((clampedEnd - winStartMin) / 15);
  return { startCol, span: Math.max(1, endCol - startCol) };
}

function Legend() {
  const items: Array<{ status: BookingStatus; label: string }> = [
    { status: "requested", label: "Requested" },
    { status: "confirmed", label: "Confirmed" },
    { status: "seated", label: "Seated" },
    { status: "finished", label: "Finished" },
    { status: "no_show", label: "No-show" },
    { status: "cancelled", label: "Cancelled" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-ash">
      <span className="font-semibold uppercase tracking-wider">Key</span>
      {items.map((i) => (
        <span
          key={i.status}
          className={`inline-flex items-center rounded-input border px-2 py-0.5 ${STATUS_FILL[i.status]}`}
        >
          {i.label}
        </span>
      ))}
      <span className="ml-2 inline-flex items-center gap-1">
        <span className="inline-block h-3 w-px bg-coral" /> now
      </span>
    </div>
  );
}

