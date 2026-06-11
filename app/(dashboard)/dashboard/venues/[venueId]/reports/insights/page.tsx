import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { LockedFeature } from "@/components/billing/locked-feature";
import { isLocked } from "@/lib/auth/entitlements";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";
import { getGuestEngagementReport } from "@/lib/reports/guest-engagement";
import { getChannelPerformanceReport } from "@/lib/reports/insights/channel-performance";
import { overallNoShowRate, sameDayShare, totalBookings } from "@/lib/reports/insights/compare";
import { getLeadTimeReport } from "@/lib/reports/insights/lead-time";
import { getNoShowTrendReport } from "@/lib/reports/insights/no-show-trend";
import { parseRange, resolveRange } from "@/lib/reports/insights/ranges";

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

type SearchParams = { range?: string; compare?: string };

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
  const { range: rangeParam, compare: compareParam } = await searchParams;
  const range = parseRange(rangeParam);
  // Comparison is on by default; only an explicit ?compare=false hides it.
  const compare = compareParam !== "false";

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id, timezone: venues.timezone })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();

  const { current, previous, fromDate, toDate } = resolveRange(range, venue.timezone, new Date());

  // Serial inside a single transaction — one pg client per tx, same as the
  // MVP reports page.
  const { leadTime, noShowTrend, channels, engagement } = await withUser(async (db) => ({
    leadTime: await getLeadTimeReport(db, venueId, current),
    noShowTrend: await getNoShowTrendReport(db, venueId, current),
    channels: await getChannelPerformanceReport(db, venueId, current),
    engagement: await getGuestEngagementReport(db, orgId, venueId, current, new Date()),
  }));

  // Compare overlay: re-run only the two queries that feed the headline
  // band against the previous equal-elapsed window (resolved time-aware,
  // so an incomplete period compares like-for-like). Channel performance
  // isn't part of the band, so it's skipped.
  const compareMetrics: CompareMetric[] | null = compare
    ? await withUser(async (db): Promise<CompareMetric[]> => {
        const prevLeadTime = await getLeadTimeReport(db, venueId, previous);
        const prevNoShow = await getNoShowTrendReport(db, venueId, previous);
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
        <DateRangeNav venueId={venueId} range={range} compare={compare} />
      </div>

      {compareMetrics ? <ComparisonBand metrics={compareMetrics} /> : null}

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
