// CSV export route for the Booking Insights surface. Mirrors the MVP
// reports export route exactly (auth + RLS + filter shape) — the only
// difference is the Plus-tier plan gate and a different report switch.
//
//   /dashboard/venues/[id]/reports/insights/export/lead-time?from=…&to=…
//
// requirePlan is enforced inside the handler so a direct hit by a
// non-Plus user gets the same 403-ish bounce as the page (the
// InsufficientPlanError throws to Next's error boundary). The sidebar
// hides the parent surface for non-Plus orgs already.

import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";
import { toCsv } from "@/lib/reports/csv";
import { parseFilter } from "@/lib/reports/filter";
import { getLeadTimeReport } from "@/lib/reports/insights/lead-time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const INSIGHTS = ["lead-time"] as const;
type InsightName = (typeof INSIGHTS)[number];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ venueId: string; insight: string }> },
) {
  const { orgId } = await requireRole("host");
  await requirePlan(orgId, "plus");

  const { venueId, insight } = await params;
  if (!isInsightName(insight)) {
    return NextResponse.json({ error: "unknown-insight" }, { status: 404 });
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

  const csv = await renderCsv(insight, venueId, parsed.bounds);
  const filename = `${insight}-${fromDate}_${toDate}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}

function isInsightName(s: string): s is InsightName {
  return (INSIGHTS as readonly string[]).includes(s);
}

async function renderCsv(
  insight: InsightName,
  venueId: string,
  bounds: { startUtc: Date; endUtc: Date; timezone: string },
): Promise<string> {
  switch (insight) {
    case "lead-time": {
      const rows = await withUser((db) => getLeadTimeReport(db, venueId, bounds));
      return toCsv(rows, [
        { header: "bucket", value: (r) => r.bucket },
        { header: "bookings", value: (r) => r.bookings },
        { header: "covers", value: (r) => r.covers },
      ]);
    }
  }
}
