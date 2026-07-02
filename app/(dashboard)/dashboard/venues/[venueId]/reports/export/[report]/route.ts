// CSV export route handler. One GET per report:
//
//   /dashboard/venues/[id]/reports/export/covers?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Auth is enforced inline (route handlers don't inherit the layout's
// requireRole). Same RLS-respecting `withUser` as the page, so a host
// from another org gets an empty result rather than someone else's
// numbers — verified by the rls-reports integration test.

import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { formatVenueDateLong } from "@/lib/bookings/time";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";
import { getCancellationsReport } from "@/lib/reports/cancellations";
import { getCoversReport } from "@/lib/reports/covers";
import { toCsv } from "@/lib/reports/csv";
import { getDepositRevenueReport } from "@/lib/reports/deposits";
import { parseFilter } from "@/lib/reports/filter";
import { getNoShowReport } from "@/lib/reports/no-show";
import { getOccupancyReport } from "@/lib/reports/occupancy";
import { getPeakTimesReport } from "@/lib/reports/peak-times";
import { getReviewsReport } from "@/lib/reports/reviews";
import { getSourceMixReport } from "@/lib/reports/sources";
import { getSpendReport } from "@/lib/reports/spend";
import { getTopGuestsReport } from "@/lib/reports/top-guests";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPORTS = [
  "covers",
  "no-show",
  "deposits",
  "sources",
  "top-guests",
  "cancellations",
  "peak-times",
  "occupancy",
  "reviews",
  "spend",
] as const;
type ReportName = (typeof REPORTS)[number];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ venueId: string; report: string }> },
) {
  await requireRole("host");
  const { venueId, report } = await params;

  if (!isReportName(report)) {
    return NextResponse.json({ error: "unknown-report" }, { status: 404 });
  }

  const url = new URL(req.url);
  const fromDate = url.searchParams.get("from");
  const toDate = url.searchParams.get("to");
  if (!fromDate || !toDate) {
    return NextResponse.json({ error: "missing-from-or-to" }, { status: 400 });
  }

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id, timezone: venues.timezone })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) {
    return NextResponse.json({ error: "venue-not-found" }, { status: 404 });
  }

  const parsed = parseFilter({ venueId, fromDate, toDate, timezone: venue.timezone });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.reason }, { status: 400 });
  }

  const csv = await renderCsv(report, venueId, parsed.bounds, venue.timezone, {
    fromDate,
    toDate,
  });
  const filename = `${report}-${fromDate}_${toDate}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}

function isReportName(s: string): s is ReportName {
  return (REPORTS as readonly string[]).includes(s);
}

async function renderCsv(
  report: ReportName,
  venueId: string,
  bounds: { startUtc: Date; endUtc: Date; timezone: string },
  timezone: string,
  range: { fromDate: string; toDate: string },
): Promise<string> {
  switch (report) {
    case "covers": {
      const rows = await withUser((db) => getCoversReport(db, venueId, bounds));
      return toCsv(rows, [
        { header: "day", value: (r) => r.day },
        { header: "service", value: (r) => r.serviceName },
        { header: "bookings", value: (r) => r.bookings },
        { header: "covers_booked", value: (r) => r.coversBooked },
        { header: "covers_realised", value: (r) => r.coversRealised },
      ]);
    }
    case "no-show": {
      const summary = await withUser((db) => getNoShowReport(db, venueId, bounds));
      // Flatten: one summary row + per-service rows. The reader knows
      // the shape from column headers; "scope" disambiguates rows.
      const rows = [
        {
          scope: "overall",
          name: "",
          eligible: summary.totalEligible,
          noShows: summary.totalNoShows,
          rate: summary.rate,
        },
        {
          scope: "with-deposit",
          name: "",
          eligible: summary.withDepositEligible,
          noShows: summary.withDepositNoShows,
          rate: summary.withDepositRate,
        },
        ...summary.byService.map((s) => ({
          scope: "service",
          name: s.serviceName,
          eligible: s.eligible,
          noShows: s.noShows,
          rate: s.rate,
        })),
      ];
      return toCsv(rows, [
        { header: "scope", value: (r) => r.scope },
        { header: "service", value: (r) => r.name },
        { header: "eligible", value: (r) => r.eligible },
        { header: "no_shows", value: (r) => r.noShows },
        { header: "rate", value: (r) => r.rate.toFixed(4) },
      ]);
    }
    case "deposits": {
      const rows = await withUser((db) => getDepositRevenueReport(db, venueId, bounds));
      return toCsv(rows, [
        { header: "day", value: (r) => r.day },
        { header: "deposits_minor", value: (r) => r.depositsCollectedMinor },
        { header: "no_show_minor", value: (r) => r.noShowCapturedMinor },
        { header: "refunded_minor", value: (r) => r.refundedMinor },
        { header: "net_minor", value: (r) => r.netMinor },
      ]);
    }
    case "sources": {
      const rows = await withUser((db) => getSourceMixReport(db, venueId, bounds));
      return toCsv(rows, [
        { header: "source", value: (r) => r.source },
        { header: "bookings", value: (r) => r.bookings },
        { header: "covers", value: (r) => r.covers },
      ]);
    }
    case "top-guests": {
      const rows = await withUser((db) => getTopGuestsReport(db, venueId, bounds));
      return toCsv(rows, [
        { header: "guest_id", value: (r) => r.guestId },
        { header: "first_name", value: (r) => r.firstName },
        { header: "visits", value: (r) => r.visits },
        { header: "last_visit", value: (r) => formatVenueDateLong(r.lastVisit, { timezone }) },
      ]);
    }
    case "cancellations": {
      const report = await withUser((db) => getCancellationsReport(db, venueId, bounds));
      // Two sections in one file, disambiguated by "scope" — same trick
      // as the no-show export.
      const rows = [
        ...report.byDay.map((r) => ({
          scope: "day",
          key: r.day,
          bookings: r.bookings,
          cancelled: r.cancelled,
        })),
        ...report.byReason.map((r) => ({
          scope: "reason",
          key: r.reason,
          bookings: null as number | null,
          cancelled: r.count,
        })),
      ];
      return toCsv(rows, [
        { header: "scope", value: (r) => r.scope },
        { header: "day_or_reason", value: (r) => r.key },
        { header: "bookings", value: (r) => r.bookings },
        { header: "cancelled", value: (r) => r.cancelled },
      ]);
    }
    case "peak-times": {
      const rows = await withUser((db) => getPeakTimesReport(db, venueId, bounds));
      return toCsv(rows, [
        { header: "iso_weekday", value: (r) => r.weekday },
        { header: "hour", value: (r) => r.hour },
        { header: "bookings", value: (r) => r.bookings },
        { header: "covers", value: (r) => r.covers },
      ]);
    }
    case "occupancy": {
      const rows = await withUser((db) => getOccupancyReport(db, venueId, bounds, range));
      return toCsv(rows, [
        { header: "service", value: (r) => r.serviceName },
        { header: "sessions", value: (r) => r.sessionsInRange },
        { header: "capacity_per_session", value: (r) => r.capacityPerSession },
        { header: "total_capacity", value: (r) => r.totalCapacity },
        { header: "covers_realised", value: (r) => r.coversRealised },
        { header: "utilisation", value: (r) => r.utilisation.toFixed(4) },
      ]);
    }
    case "reviews": {
      const report = await withUser((db) => getReviewsReport(db, venueId, bounds));
      return toCsv(report.byDay, [
        { header: "day", value: (r) => r.day },
        { header: "reviews", value: (r) => r.count },
        { header: "avg_rating", value: (r) => r.avgRating.toFixed(2) },
      ]);
    }
    case "spend": {
      const report = await withUser((db) => getSpendReport(db, venueId, bounds));
      return toCsv(report.byDay, [
        { header: "day", value: (r) => r.day },
        { header: "orders", value: (r) => r.orders },
        { header: "revenue_minor", value: (r) => r.revenueMinor },
      ]);
    }
  }
}
