// CSV export for the Stripe Connect onboarding funnel.
//
// The metric returns a flat object; we pivot it into rows keyed by
// stage so the CSV is sortable / pivotable in a spreadsheet.

import { NextResponse } from "next/server";

import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { toCsv } from "@/lib/server/admin/dashboard/csv";
import { getConnectFunnel } from "@/lib/server/admin/dashboard/metrics/connect-funnel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = { stage: string; orgs: number; percent: string };

export async function GET(): Promise<NextResponse> {
  const session = await requirePlatformAdmin();
  const funnel = await getConnectFunnel(adminDb());

  await platformAudit.log({
    actorEmail: session.email,
    action: "exported",
    metadata: { metric: "connect_funnel" },
  });

  const total = funnel.totalOrgs;
  const pct = (n: number) => (total === 0 ? "" : `${((n / total) * 100).toFixed(1)}%`);

  const rows: Row[] = [
    { stage: "all_organisations", orgs: total, percent: total === 0 ? "" : "100.0%" },
    { stage: "has_connect_account", orgs: funnel.hasAccount, percent: pct(funnel.hasAccount) },
    {
      stage: "details_submitted",
      orgs: funnel.detailsSubmitted,
      percent: pct(funnel.detailsSubmitted),
    },
    {
      stage: "charges_enabled",
      orgs: funnel.chargesEnabled,
      percent: pct(funnel.chargesEnabled),
    },
    {
      stage: "payouts_enabled",
      orgs: funnel.payoutsEnabled,
      percent: pct(funnel.payoutsEnabled),
    },
  ];

  const csv = toCsv(rows, [
    { header: "stage", value: (r) => r.stage },
    { header: "orgs", value: (r) => r.orgs },
    { header: "percent", value: (r) => r.percent },
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `connect-funnel-${stamp}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
