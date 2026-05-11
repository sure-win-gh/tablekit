// CSV export for the daily-bookings bucket series.
//
//   GET /admin/export/bookings?days=30
//
// Same shape + clamp as the signups export — kept symmetric so the
// founder can correlate the two CSVs in a spreadsheet by `day`.

import { NextResponse, type NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { toCsv } from "@/lib/server/admin/dashboard/csv";
import { getBookingsByDay } from "@/lib/server/admin/dashboard/metrics/bookings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requirePlatformAdmin();

  const url = new URL(req.url);
  const days = clampDays(url.searchParams.get("days"));

  const rows = await getBookingsByDay(adminDb(), days);

  await platformAudit.log({
    actorEmail: session.email,
    action: "exported",
    metadata: { metric: "bookings", days, count: rows.length },
  });

  const csv = toCsv(rows, [
    { header: "day", value: (r) => r.day },
    { header: "bookings", value: (r) => r.n },
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="bookings-${stamp}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}

function clampDays(raw: string | null): number {
  const parsed = raw === null ? 30 : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(365, Math.max(1, parsed));
}
