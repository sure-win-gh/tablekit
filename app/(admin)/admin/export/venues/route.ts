// CSV export for the cross-org venues / orgs list.
//
//   GET /admin/export/venues?q=...
//
// Same query string as /admin/venues so the export reflects whatever
// the founder is currently looking at. Auth is enforced inline —
// route handlers don't inherit the (admin) layout's gate. proxy.ts
// also gates /admin/* at the edge.

import { NextResponse, type NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { toCsv } from "@/lib/server/admin/dashboard/csv";
import { searchVenues } from "@/lib/server/admin/dashboard/metrics/venues-search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requirePlatformAdmin();

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";

  const rows = await searchVenues(adminDb(), q, 500);

  await platformAudit.log({
    actorEmail: session.email,
    action: "exported",
    metadata: { metric: "venues", q: q.slice(0, 200), count: rows.length },
  });

  const csv = toCsv(rows, [
    { header: "org_id", value: (r) => r.orgId },
    { header: "org_name", value: (r) => r.orgName },
    { header: "slug", value: (r) => r.slug },
    { header: "plan", value: (r) => r.plan },
    { header: "created_at", value: (r) => r.createdAt },
    { header: "venue_count", value: (r) => r.venueCount },
    { header: "owner_email", value: (r) => r.ownerEmail },
    { header: "last_booking_at", value: (r) => r.lastBookingAt },
    { header: "last_login_at", value: (r) => r.lastLoginAt },
    { header: "bookings_14d", value: (r) => r.bookings14d },
    { header: "logins_14d", value: (r) => r.logins14d },
    { header: "messages_14d", value: (r) => r.messages14d },
    { header: "activity_score", value: (r) => r.activityScore },
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `venues-${stamp}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
