// CSV export for the platform-wide audit feed.
//
//   GET /admin/export/audit?prefix=...&org_id=...&limit=...
//
// Same filters as /admin/audit so the download mirrors what the
// founder is currently looking at. Capped to 5000 rows per export
// to keep the response bounded; if you need more, narrow the prefix.

import { NextResponse, type NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { toCsv } from "@/lib/server/admin/dashboard/csv";
import { getAuditFeed } from "@/lib/server/admin/dashboard/metrics/audit-feed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_EXPORT_ROWS = 5000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requirePlatformAdmin();

  const url = new URL(req.url);
  const prefix = url.searchParams.get("prefix") ?? "";
  const orgId = url.searchParams.get("org_id") ?? "";
  const requestedLimit = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_EXPORT_ROWS)
    : 1000;

  const rows = await getAuditFeed(adminDb(), {
    actionPrefix: prefix || undefined,
    orgId: orgId || undefined,
    limit,
  });

  await platformAudit.log({
    actorEmail: session.email,
    action: "exported",
    metadata: {
      metric: "audit",
      prefix: prefix.slice(0, 100),
      org_id: orgId.slice(0, 64),
      count: rows.length,
    },
  });

  const csv = toCsv(rows, [
    { header: "created_at", value: (r) => r.createdAt },
    { header: "action", value: (r) => r.action },
    { header: "organisation_id", value: (r) => r.organisationId },
    { header: "organisation_name", value: (r) => r.organisationName },
    { header: "actor_user_id", value: (r) => r.actorUserId },
    { header: "actor_email", value: (r) => r.actorEmail },
    { header: "target_type", value: (r) => r.targetType },
    { header: "target_id", value: (r) => r.targetId },
    { header: "metadata", value: (r) => JSON.stringify(r.metadata) },
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `audit-${stamp}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
