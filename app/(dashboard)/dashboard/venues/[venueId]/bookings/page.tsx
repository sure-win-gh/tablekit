import { and, asc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { Plus } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DayOverview } from "@/components/bookings/day-overview";
import { Button } from "@/components/ui";
import { requireRole } from "@/lib/auth/require-role";
import { enrichBookingsForDisplay } from "@/lib/bookings/enriched-detail";
import { classifySearchInput, parseStatusFilter } from "@/lib/bookings/list-filters";
import { bumpAgg, emptyAgg, type OverviewAgg, type OverviewSegment } from "@/lib/bookings/overview";
import {
  formatVenueDateLong,
  formatVenueTime,
  todayInZone,
  venueLocalDayRange,
} from "@/lib/bookings/time";
import { type BookingStatus } from "@/lib/bookings/state";
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
import { hashForLookup } from "@/lib/security/crypto";

import { BookingsFilters, BookingRow, DateNav } from "./forms";

// Per-day bookings list. Defaults to today in the venue's timezone.
// `?date=YYYY-MM-DD` overrides — used by the future calendar UI and
// for deep-linking from the new-booking success screen.

export const metadata = { title: "Bookings · TableKit" };

type SearchParams = { date?: string; q?: string; status?: string };

export default async function BookingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const auth = await requireRole("host");
  const { venueId } = await params;
  const { date: dateParam, q: rawQuery, status: rawStatus } = await searchParams;
  const search = classifySearchInput(rawQuery);
  const statusFilter = parseStatusFilter(rawStatus);
  const filtersActive = search.kind !== "empty" || statusFilter.length > 0;

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

  const filterPredicates: SQL[] = [];
  if (search.kind === "email") {
    filterPredicates.push(eq(guests.emailHash, hashForLookup(search.raw, "email")));
  } else if (search.kind === "freetext") {
    const freetext = or(
      ilike(guests.firstName, search.pattern),
      ilike(bookings.notes, search.pattern),
    );
    if (freetext) filterPredicates.push(freetext);
  }
  if (statusFilter.length > 0) {
    filterPredicates.push(inArray(bookings.status, statusFilter));
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
        // Typed non-null: the services inner-join excludes event
        // bookings, and the 0060 CHECK pairs a non-null service_id
        // with a non-null area_id on every remaining row.
        areaId: sql<string>`${bookings.areaId}`.as("areaId"),
        serviceName: services.name,
        guestId: bookings.guestId,
        guestFirstName: guests.firstName,
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
          ...filterPredicates,
        ),
      )
      .orderBy(asc(bookings.startAt));
  });

  // Decrypt + count prior visits in one pass so each BookingRow can
  // render the seating-moment badges without N+1 queries.
  const enrichmentMap = await withUser(async (db) =>
    enrichBookingsForDisplay(
      db,
      auth.orgId,
      rows.map((r) => ({
        id: r.id,
        guestId: r.guestId,
        startAt: r.startAt,
        guestNotesCipher: r.guestNotesCipher,
        dietaryNotesCipher: r.dietaryNotesCipher,
        guestTags: r.guestTags,
        highChairs: r.highChairs,
      })),
    ),
  );

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
  // the move-table dropdown). Both are venue-scoped reads. Serial
  // inside the transaction — one pg client per tx.
  const { tableAssignments, allVenueTables } = await withUser(async (db) => {
    const tableAssignments =
      bookingIds.length === 0
        ? ([] as Array<{
            bookingId: string;
            tableId: string;
            label: string;
            areaId: string;
            areaName: string;
          }>)
        : await db
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
            .where(inArray(bookingTables.bookingId, bookingIds));
    const allVenueTables = await db
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
      .orderBy(asc(areas.name), asc(venueTables.label));
    return { tableAssignments, allVenueTables };
  });

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

  // Day-overview aggregates for the side card. Computed from the loaded
  // rows in one pass, so they respect any active filter — the card
  // labels itself "Filtered" when that's the case. We build an "All"
  // segment plus one per service so the card can toggle between them.
  // Covers exclude cancelled / no-show since those seats aren't filled.
  const allAgg = emptyAgg();
  const perService = new Map<string, OverviewAgg>();
  for (const r of rows) {
    const s = r.status as BookingStatus;
    const noTable = (tablesByBooking.get(r.id)?.length ?? 0) === 0;
    bumpAgg(allAgg, s, r.partySize, noTable);
    let svc = perService.get(r.serviceName);
    if (!svc) {
      svc = emptyAgg();
      perService.set(r.serviceName, svc);
    }
    bumpAgg(svc, s, r.partySize, noTable);
  }
  const overviewSegments: OverviewSegment[] = [
    { key: "all", label: "All", ...allAgg },
    ...[...perService.entries()].map(([name, agg]) => ({ key: name, label: name, ...agg })),
  ];

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-ink text-xl font-bold tracking-tight">
            {formatVenueDateLong(startUtc, { timezone: venue.timezone })}
          </h2>
          <p className="text-ash mt-0.5 text-xs">
            {rows.length === 0
              ? filtersActive
                ? "No bookings match these filters."
                : "No bookings yet."
              : `${rows.length} booking${rows.length === 1 ? "" : "s"}${filtersActive ? " (filtered)" : ""}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <DateNav venueId={venueId} date={date} />
          <Link href={`/dashboard/venues/${venueId}/bookings/new`}>
            <Button size="sm">
              <Plus className="h-4 w-4" aria-hidden />
              New booking
            </Button>
          </Link>
        </div>
      </header>

      <BookingsFilters
        venueId={venueId}
        date={date}
        initialQuery={rawQuery ?? ""}
        activeStatuses={statusFilter}
      />

      {/* On desktop the list narrows into the left column and the day
          overview sits beside it; on mobile the list stays full-width
          and the card is hidden. */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        {rows.length === 0 ? (
          <p className="rounded-card border-hairline text-ash border border-dashed p-8 text-center text-sm">
            {filtersActive
              ? "No bookings match these filters. Try clearing the search or status chips."
              : "Nothing on the books for this day. Click “New booking” to add one."}
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {[...byService.entries()].map(([svc, list]) => (
              <div key={svc}>
                <h3 className="text-ink text-sm font-semibold tracking-tight">{svc}</h3>
                <ul className="divide-hairline rounded-card border-hairline mt-2 divide-y border bg-white">
                  {list.map((b) => {
                    const assignedTables = tablesByBooking.get(b.id) ?? [];
                    const durationMinutes = Math.round(
                      (b.endAt.getTime() - b.startAt.getTime()) / 60000,
                    );
                    const enrichment = enrichmentMap.get(b.id) ?? {
                      guestTags: b.guestTags,
                      guestNotes: null,
                      dietaryNotes: null,
                      highChairs: b.highChairs,
                      priorVisits: 0,
                    };
                    return (
                      <BookingRow
                        key={b.id}
                        venueId={venueId}
                        date={date}
                        bookingId={b.id}
                        wallStart={formatVenueTime(b.startAt, { timezone: venue.timezone })}
                        wallEnd={formatVenueTime(b.endAt, { timezone: venue.timezone })}
                        durationMinutes={durationMinutes}
                        partySize={b.partySize}
                        status={b.status as BookingStatus}
                        guestId={b.guestId}
                        guestFirstName={b.guestFirstName}
                        notes={b.notes}
                        serviceName={b.serviceName}
                        areaId={b.areaId}
                        refundable={refundableSet.has(b.id)}
                        cardHold={cardHoldSet.has(b.id)}
                        noShowOutcome={noShowOutcomes.get(b.id) ?? null}
                        assignedTables={assignedTables}
                        allVenueTables={allVenueTables}
                        enrichment={enrichment}
                      />
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}

        <aside className="hidden lg:sticky lg:top-4 lg:block">
          <DayOverview segments={overviewSegments} filtersActive={filtersActive} />
        </aside>
      </div>
    </section>
  );
}
