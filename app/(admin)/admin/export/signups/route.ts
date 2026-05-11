// CSV export for the daily-signups bucket series.
//
//   GET /admin/export/signups?days=30
//
// Mirrors the data that backs the overview KPI tile's sparkline so
// the downloaded series matches what the founder is looking at.
// Range defaults to 30 days, clamped to [1, 365].
//
// Auth: requirePlatformAdmin + the (admin) layout gate + edge proxy —
// three nested checks; this route handler can't inherit the layout's
// gate so the inline call is the load-bearing one. proxy.ts adds the
// outer net.

import { NextResponse, type NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { toCsv } from "@/lib/server/admin/dashboard/csv";
import { getSignupsByDay } from "@/lib/server/admin/dashboard/metrics/signups";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requirePlatformAdmin();

  const url = new URL(req.url);
  const days = clampDays(url.searchParams.get("days"));

  const rows = await getSignupsByDay(adminDb(), days);

  await platformAudit.log({
    actorEmail: session.email,
    action: "exported",
    metadata: { metric: "signups", days, count: rows.length },
  });

  const csv = toCsv(rows, [
    { header: "day", value: (r) => r.day },
    { header: "signups", value: (r) => r.n },
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="signups-${stamp}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}

function clampDays(raw: string | null): number {
  const parsed = raw === null ? 30 : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(365, Math.max(1, parsed));
}
