import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { todayInZone } from "@/lib/bookings/time";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";
import { parseFilter } from "@/lib/reports/filter";
import { getLeadTimeReport } from "@/lib/reports/insights/lead-time";

import { DateRangeNav, LeadTimeCard } from "./forms";

export const metadata = { title: "Insights · TableKit" };

type SearchParams = { from?: string; to?: string };

export default async function InsightsPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { orgId } = await requireRole("host");
  await requirePlan(orgId, "plus");

  const { venueId } = await params;
  const { from: fromParam, to: toParam } = await searchParams;

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
  const toDate = toParam ?? today;
  const fromDate = fromParam ?? shiftDate(toDate, -29);

  const parsed = parseFilter({ venueId, fromDate, toDate, timezone: venue.timezone });
  if (!parsed.ok) {
    return (
      <section className="flex flex-col gap-4">
        <DateRangeNav venueId={venueId} fromDate={fromDate} toDate={toDate} />
        <p className="rounded-card border-rose/30 bg-rose/5 text-rose border p-4 text-sm">
          Invalid date range — pick a from/to where from ≤ to and both are YYYY-MM-DD.
        </p>
      </section>
    );
  }

  const { bounds } = parsed;
  const leadTime = await withUser((db) => getLeadTimeReport(db, venueId, bounds));

  const exportBase = `/dashboard/venues/${venueId}/reports/insights/export`;
  const queryString = `?from=${fromDate}&to=${toDate}`;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-ink text-xl font-bold tracking-tight">Insights</h2>
          <p className="text-ash mt-0.5 text-sm">
            How far in advance diners book. Times are in this venue&apos;s local zone.
          </p>
        </div>
        <DateRangeNav venueId={venueId} fromDate={fromDate} toDate={toDate} />
      </div>

      <LeadTimeCard rows={leadTime} downloadHref={`${exportBase}/lead-time${queryString}`} />
    </section>
  );
}

// Add a number of days to a YYYY-MM-DD string, in calendar terms. Used
// for the default 30-day range; small enough that DST drift doesn't
// matter (parseFilter does proper venue-zone math).
function shiftDate(ymd: string, days: number): string {
  const [y = "1970", m = "01", d = "01"] = ymd.split("-");
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
