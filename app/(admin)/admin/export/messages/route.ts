// CSV export for the 7-day message-volume breakdown.
//
//   GET /admin/export/messages
//
// The underlying metric is `getMessageVolume7d` — fixed 7-day window
// aggregated by (channel, status). There's no `days=` knob because
// the source query doesn't take one; if a longer window becomes
// useful, extend the metric first.

import { NextResponse } from "next/server";

import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { toCsv } from "@/lib/server/admin/dashboard/csv";
import { getMessageVolume7d } from "@/lib/server/admin/dashboard/metrics/messages";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const session = await requirePlatformAdmin();

  const rows = await getMessageVolume7d(adminDb());

  await platformAudit.log({
    actorEmail: session.email,
    action: "exported",
    metadata: { metric: "messages", count: rows.length },
  });

  const csv = toCsv(rows, [
    { header: "channel", value: (r) => r.channel },
    { header: "status", value: (r) => r.status },
    { header: "count_7d", value: (r) => r.count },
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="messages-${stamp}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}
