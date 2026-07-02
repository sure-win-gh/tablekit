import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { todayInZone } from "@/lib/bookings/time";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";
import { getCancellationsReport } from "@/lib/reports/cancellations";
import { getCoversReport } from "@/lib/reports/covers";
import { getDepositRevenueReport } from "@/lib/reports/deposits";
import { parseFilter } from "@/lib/reports/filter";
import { getNoShowReport } from "@/lib/reports/no-show";
import { getOccupancyReport } from "@/lib/reports/occupancy";
import { getPeakTimesReport } from "@/lib/reports/peak-times";
import { getReviewsReport } from "@/lib/reports/reviews";
import { getSourceMixReport } from "@/lib/reports/sources";
import { getSpendReport } from "@/lib/reports/spend";
import { getTopGuestsReport } from "@/lib/reports/top-guests";

import {
  type KpiItem,
  CancellationsCard,
  CoversCard,
  DateRangeNav,
  DepositsCard,
  KpiBand,
  NoShowCard,
  OccupancyCard,
  PeakTimesCard,
  ReviewsCard,
  SourcesCard,
  SpendCard,
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
        <p className="rounded-card border-rose/30 bg-rose/5 text-rose border p-4 text-sm">
          Invalid date range — pick a from/to where from ≤ to and both are YYYY-MM-DD.
        </p>
      </section>
    );
  }

  const { bounds } = parsed;
  // Serial inside the transaction — one pg client per tx.
  const {
    covers,
    noShow,
    deposits,
    sources,
    topGuests,
    cancellations,
    peakTimes,
    occupancy,
    reviewsReport,
    spend,
  } = await withUser(async (db) => ({
    covers: await getCoversReport(db, venueId, bounds),
    noShow: await getNoShowReport(db, venueId, bounds),
    deposits: await getDepositRevenueReport(db, venueId, bounds),
    sources: await getSourceMixReport(db, venueId, bounds),
    topGuests: await getTopGuestsReport(db, venueId, bounds),
    cancellations: await getCancellationsReport(db, venueId, bounds),
    peakTimes: await getPeakTimesReport(db, venueId, bounds),
    occupancy: await getOccupancyReport(db, venueId, bounds, { fromDate, toDate }),
    reviewsReport: await getReviewsReport(db, venueId, bounds),
    spend: await getSpendReport(db, venueId, bounds),
  }));

  const exportBase = `/dashboard/venues/${venueId}/reports/export`;
  const queryString = `?from=${fromDate}&to=${toDate}`;
  const href = (report: string) => `${exportBase}/${report}${queryString}`;

  // Headline numbers, derived from the already-fetched reports — no
  // extra queries.
  const coversRealised = covers.reduce((sum, r) => sum + r.coversRealised, 0);
  const totalBookings = covers.reduce((sum, r) => sum + r.bookings, 0);
  const depositNet = deposits.reduce((sum, r) => sum + r.netMinor, 0);
  const kpis: KpiItem[] = [
    { label: "Covers realised", value: String(coversRealised) },
    { label: "Bookings", value: String(totalBookings) },
    {
      label: "No-show rate",
      value: fmtPct(noShow.rate),
      sub: `${noShow.totalNoShows} of ${noShow.totalEligible}`,
      accent: noShow.rate >= 0.1 ? "coral" : "none",
    },
    {
      label: "Cancellation rate",
      value: fmtPct(cancellations.rate),
      sub: `${cancellations.cancelled} of ${cancellations.totalBookings}`,
      accent: cancellations.rate >= 0.15 ? "coral" : "none",
    },
    { label: "Deposit net", value: fmtGbp(depositNet) },
    {
      label: "Avg rating",
      value: reviewsReport.avgRating === null ? "—" : `★ ${reviewsReport.avgRating.toFixed(1)}`,
      sub: reviewsReport.count > 0 ? `${reviewsReport.count} reviews` : "no reviews",
    },
  ];

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-ink text-xl font-bold tracking-tight">Reports</h2>
          <p className="text-ash mt-0.5 text-sm">
            How the venue performed over the range below. Times are in this venue&apos;s local zone.
          </p>
        </div>
        <DateRangeNav venueId={venueId} fromDate={fromDate} toDate={toDate} />
      </div>

      <KpiBand items={kpis} />

      <CoversCard rows={covers} fromDate={fromDate} toDate={toDate} downloadHref={href("covers")} />
      <PeakTimesCard cells={peakTimes} downloadHref={href("peak-times")} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <NoShowCard summary={noShow} downloadHref={href("no-show")} />
        <CancellationsCard
          report={cancellations}
          fromDate={fromDate}
          toDate={toDate}
          downloadHref={href("cancellations")}
        />
        <DepositsCard
          rows={deposits}
          fromDate={fromDate}
          toDate={toDate}
          downloadHref={href("deposits")}
        />
        <SpendCard
          report={spend}
          fromDate={fromDate}
          toDate={toDate}
          downloadHref={href("spend")}
        />
        <SourcesCard rows={sources} downloadHref={href("sources")} />
        <ReviewsCard report={reviewsReport} downloadHref={href("reviews")} />
        <OccupancyCard rows={occupancy} downloadHref={href("occupancy")} />
        <TopGuestsCard
          rows={topGuests}
          timezone={venue.timezone}
          downloadHref={href("top-guests")}
        />
      </div>
    </section>
  );
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtGbp(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  return `${sign}£${(Math.abs(minor) / 100).toFixed(2)}`;
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
