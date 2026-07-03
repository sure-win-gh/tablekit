// CSV export for the feature-adoption snapshot on /admin/growth.
//
//   GET /admin/export/adoption
//
// One row per feature: orgs using it + % of total. Mirrors exactly
// what the Growth page renders.
//
// Auth: requirePlatformAdmin inline (route handlers don't inherit the
// layout gate); proxy.ts is the outer net.

import { NextResponse } from "next/server";

import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { toCsv } from "@/lib/server/admin/dashboard/csv";
import { getFeatureAdoption } from "@/lib/server/admin/dashboard/metrics/feature-adoption";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const session = await requirePlatformAdmin();

  const adoption = await getFeatureAdoption(adminDb());

  await platformAudit.log({
    actorEmail: session.email,
    action: "exported",
    metadata: { metric: "adoption", totalOrgs: adoption.totalOrgs },
  });

  const rows = adoption.features.map((f) => ({
    key: f.key,
    label: f.label,
    orgs: f.orgsWithFeature,
    pct:
      adoption.totalOrgs === 0
        ? "0.0"
        : ((f.orgsWithFeature / adoption.totalOrgs) * 100).toFixed(1),
  }));

  const csv = toCsv(rows, [
    { header: "feature", value: (r) => r.key },
    { header: "label", value: (r) => r.label },
    { header: "orgs", value: (r) => r.orgs },
    { header: "pct_of_orgs", value: (r) => r.pct },
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="adoption-${stamp}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}
