// CSV export for the marketing overview (marketing-suite Part 2).
//
//   /dashboard/venues/[id]/campaigns/reports/export
//
// Auth + Plus gate are enforced inline — route handlers don't inherit the
// page's checks. Same RLS-respecting `withUser` as the page, so a manager
// from another org gets an empty result, never someone else's numbers.
// Three sections (channels / top-campaigns / audience) in one file,
// disambiguated by a `section` column — same trick as the reports exports.

import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { isLocked } from "@/lib/auth/entitlements";
import { hasPlan } from "@/lib/auth/plan-level";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import {
  CHANNEL_LABEL,
  OVERVIEW_WINDOW_DAYS,
  getMarketingOverview,
} from "@/lib/campaigns/overview";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";
import { toCsv } from "@/lib/reports/csv";
import { audit } from "@/lib/server/admin/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = {
  section: string;
  key: string;
  channel: string;
  campaigns: number | null;
  sent: number | null;
  delivered: number | null;
  opened: number | null;
  clicked: number | null;
  bookings: number | null;
  covers: number | null;
  conversion: string;
};

const EMPTY = {
  campaigns: null,
  sent: null,
  delivered: null,
  opened: null,
  clicked: null,
  bookings: null,
  covers: null,
  conversion: "",
} as const;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ venueId: string }> }) {
  const { userId, orgId } = await requireRole("manager");
  const { venueId } = await params;

  const plan = await getPlan(orgId);
  if (isLocked(plan, "campaigns")) {
    return NextResponse.json({ error: "feature-locked" }, { status: 403 });
  }
  // The overview (and its export) is the Plus headline — gate server-side.
  if (!hasPlan(plan, "plus")) {
    return NextResponse.json({ error: "plus-required" }, { status: 403 });
  }

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) {
    return NextResponse.json({ error: "venue-not-found" }, { status: 404 });
  }

  const now = new Date();
  const overview = await withUser((db) => getMarketingOverview(db, venueId, now));

  const rows: Row[] = [
    ...overview.channels.map((c) => ({
      section: "channel",
      key: CHANNEL_LABEL[c.channel],
      channel: c.channel,
      campaigns: c.campaigns,
      sent: c.sends,
      delivered: c.delivered,
      opened: c.opened,
      clicked: c.clicked,
      bookings: c.bookings,
      covers: c.covers,
      conversion:
        Math.max(c.delivered, c.sends) === 0
          ? ""
          : (c.bookings / Math.max(c.delivered, c.sends)).toFixed(4),
    })),
    ...overview.topCampaigns.map((c) => ({
      ...EMPTY,
      section: "top_campaign",
      key: c.name,
      channel: c.channel,
      delivered: c.delivered,
      clicked: c.clicked,
      bookings: c.bookings,
      covers: c.covers,
      conversion: c.conversion.toFixed(4),
    })),
    ...overview.audience.map((a) => ({
      ...EMPTY,
      section: "audience",
      key: CHANNEL_LABEL[a.channel],
      channel: a.channel,
      // Reuse existing columns: consented→delivered, new→sent, unsub→bookings.
      // `section` tells the reader what each number means.
      sent: a.newOptIns,
      delivered: a.consented,
      bookings: a.unsubscribed,
      conversion: a.unsubRate.toFixed(4),
    })),
  ];

  const csv = toCsv(rows, [
    { header: "section", value: (r) => r.section },
    { header: "name", value: (r) => r.key },
    { header: "channel", value: (r) => r.channel },
    { header: "campaigns", value: (r) => r.campaigns },
    { header: "sent_or_new_optins", value: (r) => r.sent },
    { header: "delivered_or_consented", value: (r) => r.delivered },
    { header: "opened", value: (r) => r.opened },
    { header: "clicked", value: (r) => r.clicked },
    { header: "bookings_or_unsubscribed", value: (r) => r.bookings },
    { header: "covers", value: (r) => r.covers },
    { header: "conversion_or_unsub_rate", value: (r) => r.conversion },
  ]);

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "data.exported",
    targetType: "export",
    metadata: { report: "marketing-overview", venueId, windowDays: OVERVIEW_WINDOW_DAYS },
  });

  const since = overview.since.toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  const filename = `marketing-overview-${since}_${to}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
