import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { todayInZone } from "@/lib/bookings/time";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";
import { getCoversReport } from "@/lib/reports/covers";
import { getDepositRevenueReport } from "@/lib/reports/deposits";
import { parseFilter } from "@/lib/reports/filter";
import { getNoShowReport } from "@/lib/reports/no-show";
import { getSourceMixReport } from "@/lib/reports/sources";
import { getTopGuestsReport } from "@/lib/reports/top-guests";

import {
  CoversCard,
  DateRangeNav,
  DepositsCard,
  NoShowCard,
  SourcesCard,
  TopGuestsCard,
} from "./forms";

export const metadata = { title: "Reports · TableKit" };

type SearchParams = { from?: string; to?: string };

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await requireRole("host");
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

  // Default range: last 30 days ending today (venue-local).
  const today = todayInZone(venue.timezone);
  const toDate = toParam ?? today;
  const fromDate = fromParam ?? shiftDate(toDate, -29);

  const parsed = parseFilter({ venueId, fromDate, toDate, timezone: venue.timezone });
  if (!parsed.ok) {
    return (
      <section className="flex flex-col gap-4">
        <DateRangeNav venueId={venueId} fromDate={fromDate} toDate={toDate} />
        <p className="rounded-card border border-rose/30 bg-rose/5 p-4 text-sm text-rose">
          Invalid date range — pick a from/to where from ≤ to and both are YYYY-MM-DD.
        </p>
      </section>
    );
  }

  const { bounds } = parsed;
  // Serial inside the transaction — one pg client per tx.
  const { covers, noShow, deposits, sources, topGuests } = await withUser(async (db) => ({
    covers: await getCoversReport(db, venueId, bounds),
    noShow: await getNoShowReport(db, venueId, bounds),
    deposits: await getDepositRevenueReport(db, venueId, bounds),
    sources: await getSourceMixReport(db, venueId, bounds),
    topGuests: await getTopGuestsReport(db, venueId, bounds),
  }));

  const exportBase = `/dashboard/venues/${venueId}/reports/export`;
  const queryString = `?from=${fromDate}&to=${toDate}`;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">Reports</h2>
          <p className="mt-0.5 text-sm text-ash">
            Covers, no-shows, deposits, source mix, and returning guests for the date range below.
            Times are in this venue&apos;s local zone.
          </p>
        </div>
        <DateRangeNav venueId={venueId} fromDate={fromDate} toDate={toDate} />
      </div>

      <CoversCard rows={covers} downloadHref={`${exportBase}/covers${queryString}`} />
      <NoShowCard summary={noShow} downloadHref={`${exportBase}/no-show${queryString}`} />
      <DepositsCard rows={deposits} downloadHref={`${exportBase}/deposits${queryString}`} />
      <SourcesCard rows={sources} downloadHref={`${exportBase}/sources${queryString}`} />
      <TopGuestsCard
        rows={topGuests}
        timezone={venue.timezone}
        downloadHref={`${exportBase}/top-guests${queryString}`}
      />
    </section>
  );
}

// Add a number of days to a YYYY-MM-DD string, in calendar terms.
// Used for the default 30-day range; small enough that DST drift
// doesn't matter (the parseFilter step does proper venue-zone math).
function shiftDate(ymd: string, days: number): string {
  const [y = "1970", m = "01", d = "01"] = ymd.split("-");
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
