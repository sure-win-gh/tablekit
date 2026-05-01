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
import { STATUS_FILL } from "@/lib/bookings/status-style";
import { withUser } from "@/lib/db/client";
import {
  areas,
  bookingTables,
  bookings,
  guests,
  payments,
  services,
  venueTables,
  venues,
} from "@/lib/db/schema";
import { formatInTimeZone } from "date-fns-tz";

import {
  BookingDetailModal,
  NewBookingModal,
  TimelineDateNav,
  TimelineDragProvider,
  TimelineRow,
  TimelineScroller,
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

  const today = todayInZone(venue.timezone);
  const date = dateParam ?? today;
  const { startUtc, endUtc } = venueLocalDayRange(date, venue.timezone);

  const {
    tables,
    bookingsForDay,
    assignments,
    services: svcRows,
    paymentRows,
  } = await withUser(async (db) => {
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
          guestId: bookings.guestId,
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

    // Same payment-shape signals the bookings list uses for its row
    // actions: refundable (succeeded deposit), cardHold (succeeded
    // hold = flow B), noShowOutcome (the no-show capture row's
    // status, if one exists). Lets the detail modal render the
    // refund button + the no-show outcome badge.
    const paymentRows =
      bookingIds.length === 0
        ? ([] as Array<{ bookingId: string; kind: string; status: string }>)
        : await db
            .select({
              bookingId: payments.bookingId,
              kind: payments.kind,
              status: payments.status,
            })
            .from(payments)
            .where(inArray(payments.bookingId, bookingIds));

    return {
      tables: tableRows,
      bookingsForDay: bookingRows,
      assignments: assignmentRows,
      services: svcRows,
      paymentRows,
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

  // Payment-shape signals — same ones the bookings list computes.
  const refundableSet = new Set<string>();
  const cardHoldSet = new Set<string>();
  const noShowOutcomes = new Map<string, "captured" | "failed">();
  for (const p of paymentRows) {
    if (p.kind === "deposit" && p.status === "succeeded") refundableSet.add(p.bookingId);
    if (p.kind === "hold" && p.status === "succeeded") cardHoldSet.add(p.bookingId);
    if (p.kind === "no_show_capture") {
      noShowOutcomes.set(p.bookingId, p.status === "succeeded" ? "captured" : "failed");
    }
  }

  // Build hour-tick labels for the header row.
  //
  // Iterates [startHour, endHour) — *exclusive* of endHour. Including
  // endHour as a tick would place a label at gridColumn (totalSlots
  // + 2), past the explicit template's last column. CSS grid then
  // auto-creates an implicit column to fit the label, sized via
  // grid-auto-columns: auto, which steals width from the `1fr`
  // columns and makes the header columns narrower than the body
  // columns below — misaligning everything.
  //
  // The right edge of the grid implicitly = endHour:00; operators
  // infer it from the last labelled hour. Label-at-the-right-edge
  // is doable but needs absolute positioning that's not worth the
  // complexity.
  const hourTicks: number[] = [];
  for (let h = window.startHour; h < window.endHour; h++) hourTicks.push(h);

  // Service-name banners for the top header row. Same column-math as
  // bookings: clamp to window, slot-aligned. +2 on startCol to skip
  // the table-label column. Services that fall entirely outside the
  // window drop out.
  const serviceSpans = svcRows
    .map((s) => {
      const sched = s.schedule as { start?: string; end?: string } | null;
      if (!sched?.start || !sched?.end) return null;
      const sm = parseHHMM(sched.start);
      const em = parseHHMM(sched.end);
      const winStart = window.startHour * 60;
      const winEnd = window.endHour * 60;
      const cs = Math.max(sm, winStart);
      const ce = Math.min(em, winEnd);
      if (ce <= cs) return null;
      const startSlot = Math.floor((cs - winStart) / 15);
      const span = Math.ceil((ce - cs) / 15);
      return {
        id: s.id,
        name: s.name,
        startCol: startSlot + 2,
        span,
        color: serviceColor(s.id),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Single source of truth for the column template — every grid row
  // (service banner, hour ticks, area divider, table rows) shares it
  // so columns line up.
  const gridCols = `120px repeat(${totalSlots}, max(50px, calc((100cqw - 120px) / 16)))`;

  // "Now" indicator — minutes from window-start in venue zone.
  const nowMinutes = (() => {
    const now = new Date();
    const nowHour = Number(formatInTimeZone(now, venue.timezone, "H"));
    const nowMin = Number(formatInTimeZone(now, venue.timezone, "m"));
    const offsetMin = (nowHour - window.startHour) * 60 + nowMin;
    if (offsetMin < 0 || offsetMin > totalSlots * 15) return null;
    return offsetMin;
  })();

  // Where to land scrollLeft on first paint: 30 min before now, so
  // the visible 4-hour window runs from now − 30 min to now + 3h 30 min.
  // Only auto-scrolls when viewing today; on other days the scroller
  // sits at the start of the day window.
  const initialScrollMinutes =
    date === today && nowMinutes !== null ? Math.max(0, nowMinutes - 30) : null;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-ink text-xl font-bold tracking-tight">
            {formatVenueDateLong(startUtc, { timezone: venue.timezone })}
          </h2>
          <p className="text-ash mt-0.5 text-xs">
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
        <p className="rounded-card border-hairline text-ash border border-dashed p-8 text-center text-sm">
          No tables in this venue yet. Add some on the Floor plan tab.
        </p>
      ) : (
        <Legend />
      )}

      {tables.length > 0 ? (
        <TimelineScroller scrollToMinutes={initialScrollMinutes}>
          {/* w-max so the inner wrapper stretches to the grid's intrinsic
              width. Without it, block-level default = scroll-container
              width, the now-line's `100%` resolves to visible width
              rather than full grid width, and the line lands at the
              wrong time. */}
          <div className="relative w-max min-w-full">
            {/* Two-row sticky header: service-name banners on top
                (per-service colour), hour ticks below. */}
            <div className="sticky top-0 z-40 bg-white">
              <div
                className="border-hairline bg-cloud/60 grid border-b"
                style={{ gridTemplateColumns: gridCols }}
              >
                <div className="border-hairline bg-cloud/60 text-ash sticky left-0 z-10 border-r px-3 py-1 text-[11px] font-semibold tracking-wider uppercase">
                  Service
                </div>
                {serviceSpans.map((s) => (
                  <div
                    key={s.id}
                    style={{ gridColumn: `${s.startCol} / span ${s.span}`, gridRow: 1 }}
                    className={`rounded-input m-0.5 truncate border px-2 py-0.5 text-[11px] font-semibold ${s.color}`}
                  >
                    {s.name}
                  </div>
                ))}
              </div>
              <div
                className="border-hairline grid border-b bg-white"
                style={{ gridTemplateColumns: gridCols }}
              >
                <div className="border-hairline text-ash sticky left-0 z-10 border-r bg-white px-3 py-2 text-[11px] font-semibold tracking-wider uppercase">
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
                    className="border-hairline text-ash border-r px-2 py-2 font-mono text-[11px] tabular-nums"
                  >
                    {String(h).padStart(2, "0")}:00
                  </div>
                ))}
              </div>
            </div>

            {/* Area + table rows */}
            <div className="relative">
              {/* Now indicator overlays the whole grid. */}
              {nowMinutes !== null ? (
                <div
                  aria-label="now"
                  className="bg-coral pointer-events-none absolute inset-y-0 z-20 w-px"
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
                <BookingDetailModal
                  venueId={venueId}
                  date={date}
                  allVenueTables={tables.map((t) => ({
                    id: t.id,
                    label: t.label,
                    areaId: t.areaId,
                    areaName: t.areaName,
                    maxCover: t.maxCover,
                  }))}
                />
                {areaOrder.map((areaId) => {
                  const areaTables = tablesByArea.get(areaId) ?? [];
                  const areaName = areaTables[0]?.areaName ?? "";
                  return (
                    <div key={areaId}>
                      {/* Area divider laid out as a grid row so the
                          per-15-min vertical lines stay continuous
                          across area boundaries. The label cell is
                          sticky-left like every other left column. */}
                      <div
                        className="border-hairline bg-cloud grid border-b"
                        style={{ gridTemplateColumns: gridCols }}
                      >
                        <div className="border-hairline bg-cloud text-ash sticky left-0 z-30 border-r px-3 py-1.5 text-[11px] font-semibold tracking-wider uppercase">
                          {areaName}
                        </div>
                        {Array.from({ length: totalSlots }, (_, i) => (
                          <div
                            key={i}
                            style={{ gridColumn: i + 2, gridRow: 1 }}
                            className={
                              i % 4 === 3
                                ? "border-hairline border-r"
                                : "border-hairline/40 border-r"
                            }
                          />
                        ))}
                      </div>
                      {areaTables.map((t) => {
                        const tableBookings = bookingsByTable.get(t.id) ?? [];
                        const blocks: TimelineBookingBlock[] = tableBookings.flatMap((b) => {
                          const span = bookingSpan(b.startAt, b.endAt, venue.timezone, window);
                          if (!span) return [];
                          return [
                            {
                              id: b.id,
                              // +2 to convert a 0-indexed slot into its 1-indexed
                              // grid column AND skip past the table-label column
                              // at col 1. (The +1 we used previously was off-by-
                              // one — 11:00 bookings rendered at the 10:45 column.)
                              startCol: span.startCol + 2,
                              span: span.span,
                              status: b.status as BookingStatus,
                              wallStart: formatVenueTime(b.startAt, {
                                timezone: venue.timezone,
                              }),
                              wallEnd: formatVenueTime(b.endAt, {
                                timezone: venue.timezone,
                              }),
                              guestId: b.guestId,
                              guestFirstName: b.guestFirstName,
                              partySize: b.partySize,
                              notes: b.notes,
                              serviceName: b.serviceName,
                              refundable: refundableSet.has(b.id),
                              cardHold: cardHoldSet.has(b.id),
                              noShowOutcome: noShowOutcomes.get(b.id) ?? null,
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
                            areaName={t.areaName}
                            totalSlots={totalSlots}
                            windowStartHour={window.startHour}
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
        </TimelineScroller>
      ) : null}
    </section>
  );
}

// Top-of-file helpers — kept module-local so they don't pollute the
// shared lib/bookings/time module with timeline-specific logic.

function parseHHMM(s: string): number {
  const [hh = "0", mm = "0"] = s.split(":");
  return Number(hh) * 60 + Number(mm);
}

// Stable per-service colour so each service reads as a distinct band
// in the header. Hash the id to an index; the palette is small enough
// that collisions are visible only with many overlapping services.
const SERVICE_PALETTE = [
  "bg-violet-100 border-violet-300 text-violet-900",
  "bg-cyan-100 border-cyan-300 text-cyan-900",
  "bg-fuchsia-100 border-fuchsia-300 text-fuchsia-900",
  "bg-orange-100 border-orange-300 text-orange-900",
  "bg-teal-100 border-teal-300 text-teal-900",
  "bg-pink-100 border-pink-300 text-pink-900",
];

function serviceColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return SERVICE_PALETTE[h % SERVICE_PALETTE.length]!;
}

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
    <div className="text-ash flex flex-wrap items-center gap-2 text-[11px]">
      <span className="font-semibold tracking-wider uppercase">Key</span>
      {items.map((i) => (
        <span
          key={i.status}
          className={`rounded-input inline-flex items-center border px-2 py-0.5 ${STATUS_FILL[i.status]}`}
        >
          {i.label}
        </span>
      ))}
      <span className="ml-2 inline-flex items-center gap-1">
        <span className="bg-coral inline-block h-3 w-px" /> now
      </span>
    </div>
  );
}
