import { and, eq, gte, lt } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { findSlots, type ServiceSpec } from "@/lib/bookings/availability";
import { todayInZone, venueLocalDayRange } from "@/lib/bookings/time";
import { withUser } from "@/lib/db/client";
import { bookingTables, services, venueTables, venues } from "@/lib/db/schema";

import { NewBookingForm, SlotPicker } from "./forms";

export const metadata = { title: "New booking · TableKit" };

type SearchParams = {
  date?: string;
  party?: string;
  serviceId?: string;
  wallStart?: string;
};

// Two states:
// 1. No service/time picked — show date + party + slot grid
// 2. Service + time picked — show guest form ready to submit

export default async function NewBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await requireRole("host");
  const { venueId } = await params;
  const sp = await searchParams;

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id, timezone: venues.timezone, name: venues.name })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();

  const date = sp.date ?? todayInZone(venue.timezone);
  const partySize = sp.party ? Math.max(1, Math.min(20, Number(sp.party))) : 2;

  // Load enough to render the slot grid + show table-option labels.
  const [serviceRows, tableRows] = await withUser(async (db) => {
    const svc = await db
      .select({
        id: services.id,
        name: services.name,
        schedule: services.schedule,
        turnMinutes: services.turnMinutes,
      })
      .from(services)
      .where(eq(services.venueId, venueId));
    const tbl = await db
      .select({
        id: venueTables.id,
        label: venueTables.label,
        areaId: venueTables.areaId,
        minCover: venueTables.minCover,
        maxCover: venueTables.maxCover,
      })
      .from(venueTables)
      .where(eq(venueTables.venueId, venueId));
    return [svc, tbl] as const;
  });
  const tableLabelById = new Map(tableRows.map((t) => [t.id, t.label]));

  const { startUtc, endUtc } = venueLocalDayRange(date, venue.timezone);
  const occupied = await withUser(async (db) =>
    db
      .select({
        tableId: bookingTables.tableId,
        startAt: bookingTables.startAt,
        endAt: bookingTables.endAt,
      })
      .from(bookingTables)
      .where(
        and(
          eq(bookingTables.venueId, venueId),
          gte(bookingTables.startAt, startUtc),
          lt(bookingTables.startAt, endUtc),
        ),
      ),
  );

  const serviceSpecs: ServiceSpec[] = serviceRows.map((s) => ({
    id: s.id,
    name: s.name,
    schedule: s.schedule as ServiceSpec["schedule"],
    turnMinutes: s.turnMinutes,
  }));
  const slots = findSlots({
    timezone: venue.timezone,
    date,
    partySize,
    services: serviceSpecs,
    tables: tableRows,
    occupied,
  });

  const picked =
    sp.serviceId && sp.wallStart
      ? slots.find((s) => s.serviceId === sp.serviceId && s.wallStart === sp.wallStart)
      : undefined;

  return (
    <section className="flex flex-col gap-6">
      <nav className="text-sm">
        <Link
          href={`/dashboard/venues/${venueId}/bookings`}
          className="text-neutral-500 hover:underline"
        >
          ← Back to bookings
        </Link>
      </nav>

      <SlotPicker
        venueId={venueId}
        date={date}
        partySize={partySize}
        slots={slots.map((s) => ({
          serviceId: s.serviceId,
          serviceName: s.serviceName,
          wallStart: s.wallStart,
          // Carry every offered option so the picker can render
          // "T4 + T5" labels and let the user choose between options
          // when more than one fits. Bounded by buildTableOptions —
          // realistic venues see ≤ ~5 options per slot.
          options: s.options.map((opt) => ({
            tableIds: opt.tableIds,
            tableLabels: opt.tableIds
              .map((id) => tableLabelById.get(id) ?? "?")
              .map((label) => `T${label}`),
          })),
        }))}
        picked={picked ? { serviceId: picked.serviceId, wallStart: picked.wallStart } : null}
      />

      {picked ? (
        <NewBookingForm
          venueId={venueId}
          serviceId={picked.serviceId}
          date={date}
          wallStart={picked.wallStart}
          partySize={partySize}
          options={picked.options.map((opt) => ({
            tableIds: opt.tableIds,
            tableLabels: opt.tableIds
              .map((id) => tableLabelById.get(id) ?? "?")
              .map((label) => `T${label}`),
          }))}
        />
      ) : null}
    </section>
  );
}
