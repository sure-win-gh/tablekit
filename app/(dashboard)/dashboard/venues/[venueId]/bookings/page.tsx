import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import {
  formatVenueDateLong,
  formatVenueTime,
  todayInZone,
  venueLocalDayRange,
} from "@/lib/bookings/time";
import { nextActions, type BookingStatus } from "@/lib/bookings/state";
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
import { processNextBatch } from "@/lib/messaging/dispatch";
import { sweepDueNoShowCaptures } from "@/lib/payments/no-show";

import { BookingRow, DateNav } from "./forms";

// Per-day bookings list. Defaults to today in the venue's timezone.
// `?date=YYYY-MM-DD` overrides — used by the future calendar UI and
// for deep-linking from the new-booking success screen.

export const metadata = { title: "Bookings · TableKit" };

type SearchParams = { date?: string };

export default async function BookingsPage({
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
      .select({ id: venues.id, timezone: venues.timezone, locale: venues.locale })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();

  const date = dateParam ?? todayInZone(venue.timezone);
  const { startUtc, endUtc } = venueLocalDayRange(date, venue.timezone);

  // Best-effort sweeps for this venue. Runs on every page load so
  // during-service traffic captures abandoned holds + drains the
  // messaging queue in near-real-time (Vercel Hobby cron is once-
  // daily — see vercel.json). Failures log + continue so the
  // operator's bookings view never blocks.
  try {
    await sweepDueNoShowCaptures({ venueId });
  } catch (err) {
    console.error("[dashboard/bookings] inline no-show sweep failed:", {
      venueId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await processNextBatch({ limit: 25 });
  } catch (err) {
    console.error("[dashboard/bookings] inline messaging drain failed:", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const rows = await withUser(async (db) => {
    return db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        endAt: bookings.endAt,
        partySize: bookings.partySize,
        status: bookings.status,
        notes: bookings.notes,
        areaId: bookings.areaId,
        serviceName: services.name,
        guestFirstName: guests.firstName,
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
      )
      .orderBy(asc(bookings.startAt));
  });

  // Single query for all the payment-shape signals the row needs:
  //   * refundable        — has a succeeded deposit
  //   * hasCardHold       — has a succeeded card-hold (flow B booking)
  //   * noShowOutcome     — 'captured' | 'failed' | undefined for the
  //                          no-show capture row, if any
  const bookingIds = rows.map((r) => r.id);
  const paymentRows =
    bookingIds.length === 0
      ? []
      : await withUser(async (db) =>
          db
            .select({
              bookingId: payments.bookingId,
              kind: payments.kind,
              status: payments.status,
            })
            .from(payments)
            .where(inArray(payments.bookingId, bookingIds)),
        );

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

  // Per-booking table assignments + the venue's full table list (for
  // the move-table dropdown). Both are venue-scoped reads.
  const [tableAssignments, allVenueTables] = await withUser(async (db) =>
    Promise.all([
      bookingIds.length === 0
        ? Promise.resolve(
            [] as Array<{
              bookingId: string;
              tableId: string;
              label: string;
              areaId: string;
              areaName: string;
            }>,
          )
        : db
            .select({
              bookingId: bookingTables.bookingId,
              tableId: bookingTables.tableId,
              label: venueTables.label,
              areaId: venueTables.areaId,
              areaName: areas.name,
            })
            .from(bookingTables)
            .innerJoin(venueTables, eq(venueTables.id, bookingTables.tableId))
            .innerJoin(areas, eq(areas.id, venueTables.areaId))
            .where(inArray(bookingTables.bookingId, bookingIds)),
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
        .orderBy(asc(areas.name), asc(venueTables.label)),
    ]),
  );

  type AssignedTable = { id: string; label: string; areaName: string };
  const tablesByBooking = new Map<string, AssignedTable[]>();
  for (const a of tableAssignments) {
    const list = tablesByBooking.get(a.bookingId) ?? [];
    list.push({ id: a.tableId, label: a.label, areaName: a.areaName });
    tablesByBooking.set(a.bookingId, list);
  }

  // Group by service for the day view (lunch / dinner etc.). Empty
  // groups are hidden.
  const byService = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byService.get(r.serviceName) ?? [];
    list.push(r);
    byService.set(r.serviceName, list);
  }

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">
            {formatVenueDateLong(startUtc, { timezone: venue.timezone })}
          </h2>
          <p className="text-xs text-neutral-500">
            {rows.length === 0
              ? "No bookings yet."
              : `${rows.length} booking${rows.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <DateNav venueId={venueId} date={date} />
          <Link
            href={`/dashboard/venues/${venueId}/bookings/new`}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-800"
          >
            + New booking
          </Link>
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">
          Nothing on the books for this day. Click &ldquo;New booking&rdquo; to add one.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {[...byService.entries()].map(([svc, list]) => (
            <div key={svc}>
              <h3 className="text-sm font-semibold tracking-tight text-neutral-700">{svc}</h3>
              <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
                {list.map((b) => {
                  const assignedTables = tablesByBooking.get(b.id) ?? [];
                  // Move-target candidates: same area, capacity ≥ party,
                  // not already assigned to this booking.
                  const assignedIds = new Set(assignedTables.map((t) => t.id));
                  const moveTargets = allVenueTables.filter(
                    (t) =>
                      t.areaId === b.areaId && t.maxCover >= b.partySize && !assignedIds.has(t.id),
                  );
                  return (
                    <BookingRow
                      key={b.id}
                      venueId={venueId}
                      bookingId={b.id}
                      wallStart={formatVenueTime(b.startAt, { timezone: venue.timezone })}
                      wallEnd={formatVenueTime(b.endAt, { timezone: venue.timezone })}
                      partySize={b.partySize}
                      status={b.status as BookingStatus}
                      actions={nextActions(b.status as BookingStatus)}
                      guestFirstName={b.guestFirstName}
                      notes={b.notes}
                      refundable={refundableSet.has(b.id)}
                      cardHold={cardHoldSet.has(b.id)}
                      noShowOutcome={noShowOutcomes.get(b.id) ?? null}
                      assignedTables={assignedTables}
                      moveTargets={moveTargets}
                    />
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
