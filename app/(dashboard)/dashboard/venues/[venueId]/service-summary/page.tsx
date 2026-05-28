import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { Card, CardBody } from "@/components/ui";
import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { formatVenueTime, todayInZone } from "@/lib/bookings/time";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";
import { getHeatmap } from "@/lib/services/heatmap";
import { getServiceSummary, type ServiceSummaryRow } from "@/lib/services/summary";

import { HeatmapCalendar, ServiceSummaryDateNav } from "./forms";

export const metadata = { title: "Service summary · TableKit" };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function ServiceSummaryPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { orgId } = await requireRole("host");
  await requirePlan(orgId, "plus");

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
  const date = dateParam && DATE_RE.test(dateParam) ? dateParam : today;
  const monthFirst = `${date.slice(0, 7)}-01`;

  const { rows, heatmap } = await withUser(async (db) => ({
    rows: await getServiceSummary(db, venueId, date, venue.timezone),
    heatmap: await getHeatmap(db, venueId, monthFirst, venue.timezone),
  }));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-ink text-xl font-bold tracking-tight">Service summary</h2>
          <p className="text-ash mt-0.5 text-sm">
            How full each service is against capacity. Times are in this venue&apos;s local zone.
          </p>
        </div>
        <ServiceSummaryDateNav venueId={venueId} date={date} today={today} />
      </div>

      <Card>
        <CardBody>
          <HeatmapCalendar
            venueId={venueId}
            selectedDate={date}
            monthFirst={monthFirst}
            days={heatmap}
          />
        </CardBody>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-ash text-sm">No services scheduled on this day.</p>
          </CardBody>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((r) => (
            <ServiceCard key={r.serviceId} row={r} timezone={venue.timezone} />
          ))}
        </div>
      )}
    </section>
  );
}

function utilisationTone(u: number): string {
  if (u >= 0.95) return "bg-rose-500";
  if (u >= 0.7) return "bg-amber-500";
  return "bg-emerald-500";
}

function ServiceCard({ row, timezone }: { row: ServiceSummaryRow; timezone: string }) {
  const pct = Math.round(row.utilisation * 100);
  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-ink text-sm font-semibold">{row.serviceName}</span>
            <span className="text-ash text-xs">
              {formatVenueTime(row.windowStart, { timezone })}–
              {formatVenueTime(row.windowEnd, { timezone })}
            </span>
          </div>
          <span className="text-ash text-xs tabular-nums">{row.openSlots} open slots</span>
        </div>

        <div className="mt-2 flex items-center gap-3">
          <div className="bg-cloud rounded-pill h-2 flex-1 overflow-hidden">
            <div
              className={`h-full ${utilisationTone(row.utilisation)}`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <span className="text-ink w-28 text-right text-xs font-semibold tabular-nums">
            {row.bookedCovers}/{row.capacity} · {pct}%
          </span>
        </div>
      </CardBody>
    </Card>
  );
}
