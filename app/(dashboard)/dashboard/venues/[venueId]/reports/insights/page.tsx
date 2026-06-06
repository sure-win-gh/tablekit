import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { LockedFeature } from "@/components/billing/locked-feature";
import { isLocked } from "@/lib/auth/entitlements";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { todayInZone } from "@/lib/bookings/time";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";
import { parseFilter } from "@/lib/reports/filter";
import { getGuestEngagementReport } from "@/lib/reports/guest-engagement";
import { getChannelPerformanceReport } from "@/lib/reports/insights/channel-performance";
import {
  overallNoShowRate,
  previousEquivalentBounds,
  sameDayShare,
  totalBookings,
} from "@/lib/reports/insights/compare";
import { getLeadTimeReport } from "@/lib/reports/insights/lead-time";
import { getNoShowTrendReport } from "@/lib/reports/insights/no-show-trend";

import {
  type CompareMetric,
  ChannelPerformanceCard,
  ComparisonBand,
  DateRangeNav,
  GuestEngagementCard,
  LeadTimeCard,
  NoShowTrendCard,
} from "./forms";

export const metadata = { title: "Insights · TableKit" };

type SearchParams = { from?: string; to?: string; compare?: string };

export default async function InsightsPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { orgId } = await requireRole("host");
  const plan = await getPlan(orgId);
  if (isLocked(plan, "insights")) {
    return <LockedFeature feature="insights" currentPlan={plan} />;
  }

  const { venueId } = await params;
  const { from: fromParam, to: toParam, compare: compareParam } = await searchParams;
  const compare = compareParam === "true";

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
        <DateRangeNav venueId={venueId} fromDate={fromDate} toDate={toDate} compare={compare} />
        <p className="rounded-card border-rose/30 bg-rose/5 text-rose border p-4 text-sm">
          Invalid date range — pick a from/to where from ≤ to and both are YYYY-MM-DD.
        </p>
      </section>
    );
  }

  const { bounds } = parsed;
  // Serial inside a single transaction — one pg client per tx, same as the
  // MVP reports page.
  const { leadTime, noShowTrend, channels, engagement } = await withUser(async (db) => ({
    leadTime: await getLeadTimeReport(db, venueId, bounds),
    noShowTrend: await getNoShowTrendReport(db, venueId, bounds),
    channels: await getChannelPerformanceReport(db, venueId, bounds),
    engagement: await getGuestEngagementReport(db, orgId, venueId, bounds, new Date()),
  }));

  // Compare overlay: re-run only the two queries that feed the headline
  // band against the previous equal-length window. Channel performance
  // isn't part of the band, so it's skipped.
  const comparison = compare ? previousEquivalentBounds(bounds) : null;
  const compareMetrics: CompareMetric[] | null = comparison
    ? await withUser(async (db): Promise<CompareMetric[]> => {
        const prevLeadTime = await getLeadTimeReport(db, venueId, comparison.bounds);
        const prevNoShow = await getNoShowTrendReport(db, venueId, comparison.bounds);
        return [
          {
            label: "Bookings",
            current: totalBookings(leadTime),
            previous: totalBookings(prevLeadTime),
            format: "count",
            direction: "up-good",
          },
          {
            label: "No-show rate",
            current: overallNoShowRate(noShowTrend),
            previous: overallNoShowRate(prevNoShow),
            format: "pct",
            direction: "down-good",
          },
          {
            label: "Same-day share",
            current: sameDayShare(leadTime),
            previous: sameDayShare(prevLeadTime),
            format: "pct",
            direction: "neutral",
          },
        ];
      })
    : null;

  const exportBase = `/dashboard/venues/${venueId}/reports/insights/export`;
  const queryString = `?from=${fromDate}&to=${toDate}`;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-ink text-xl font-bold tracking-tight">Insights</h2>
          <p className="text-ash mt-0.5 text-sm">
            How far in advance diners book, how no-shows are trending, and which channels are
            winning. Times are in this venue&apos;s local zone.
          </p>
        </div>
        <DateRangeNav venueId={venueId} fromDate={fromDate} toDate={toDate} compare={compare} />
      </div>

      {compareMetrics && comparison ? (
        <ComparisonBand metrics={compareMetrics} partial={comparison.partial} />
      ) : null}

      <LeadTimeCard rows={leadTime} downloadHref={`${exportBase}/lead-time${queryString}`} />
      <NoShowTrendCard
        rows={noShowTrend}
        downloadHref={`${exportBase}/no-show-trend${queryString}`}
      />
      <ChannelPerformanceCard
        rows={channels}
        downloadHref={`${exportBase}/channel-performance${queryString}`}
      />
      <GuestEngagementCard report={engagement} />
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
