// CSV export for the last-7-days payment failure list, grouped by
// org. Sourced from getPaymentFailures7d so we don't fan out the
// full operations snapshot just to dump one section.

import { NextResponse } from "next/server";

import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { toCsv } from "@/lib/server/admin/dashboard/csv";
import { getPaymentFailures7d } from "@/lib/server/admin/dashboard/metrics/operations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const session = await requirePlatformAdmin();

  const rows = await getPaymentFailures7d(adminDb());

  await platformAudit.log({
    actorEmail: session.email,
    action: "exported",
    metadata: { metric: "payment_failures_7d", count: rows.length },
  });

  const csv = toCsv(rows, [
    { header: "org_id", value: (r) => r.orgId },
    { header: "org_name", value: (r) => r.orgName },
    { header: "failures", value: (r) => r.count },
    { header: "last_failure_at", value: (r) => r.lastFailureAt },
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `payment-failures-${stamp}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
