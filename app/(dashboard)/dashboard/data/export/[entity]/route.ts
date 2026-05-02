// Inline operator export — bookings or guests, CSV or JSON.
//
//   GET /dashboard/data/export/guests?format=csv
//   GET /dashboard/data/export/bookings?format=json
//
// Spec: docs/specs/import-export.md (Export AC — available from
// dashboard Settings → Data, encrypted PII columns decrypted in the
// export, exports logged in audit_log). PR1 covers the two largest
// entities inline (no Storage hop, no signed URL — see IE2 in
// .claude/plans/import-export.md). Payments + messages + full-backup
// zip land in PR2 with the job table + signed URLs.
//
// Role floor is `manager` — matches /dashboard/privacy-requests, the
// other PII-bulk surface. Hosts can export per-venue reports already
// (lib/reports/*) which is a smaller PII surface; bulk decrypted
// emails are operator-or-above territory.

import { NextResponse, type NextRequest } from "next/server";

import { InsufficientPlanError, requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { bookingsToCsv, bookingsToJson, loadBookingsForExport } from "@/lib/export/bookings";
import { guestsToCsv, guestsToJson, loadGuestsForExport } from "@/lib/export/guests";
import { audit } from "@/lib/server/admin/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENTITIES = ["guests", "bookings"] as const;
const FORMATS = ["csv", "json"] as const;
type Entity = (typeof ENTITIES)[number];
type Format = (typeof FORMATS)[number];

export async function GET(req: NextRequest, { params }: { params: Promise<{ entity: string }> }) {
  const { orgId, userId } = await requireRole("manager");
  const { entity } = await params;
  if (!isEntity(entity)) {
    return NextResponse.json({ error: "unknown-entity" }, { status: 404 });
  }

  const format = req.nextUrl.searchParams.get("format") ?? "csv";
  if (!isFormat(format)) {
    return NextResponse.json({ error: "unknown-format" }, { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const filename = `tablekit-${entity}-${today}.${format}`;

  // Both bulk exports decrypt PII (guests: full record; bookings:
  // joined guest_email per row), so both are CRM-tier features. We
  // audit-log the rejection symmetric with the Resend webhook
  // precedent — useful signal that a Free/Core member is probing the
  // URL directly. (See app/api/webhooks/resend-inbound/route.ts.)
  try {
    await requirePlan(orgId, "plus");
  } catch (err) {
    if (err instanceof InsufficientPlanError) {
      await audit.log({
        organisationId: orgId,
        actorUserId: userId,
        action: "data.export.plan_rejected",
        targetType: "export",
        metadata: { entity, format, required: "plus" },
      });
      return NextResponse.json({ error: "plan-required", required: "plus" }, { status: 402 });
    }
    throw err;
  }

  let body: string;
  let rowCount: number;
  if (entity === "guests") {
    const rows = await withUser((db) => loadGuestsForExport(db, orgId));
    rowCount = rows.length;
    body = format === "csv" ? guestsToCsv(rows) : guestsToJson(rows);
  } else {
    const rows = await withUser((db) => loadBookingsForExport(db, orgId));
    rowCount = rows.length;
    body = format === "csv" ? bookingsToCsv(rows) : bookingsToJson(rows);
  }

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "data.exported",
    targetType: "export",
    metadata: { entity, format, rowCount },
  });

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type":
        format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}

function isEntity(s: string): s is Entity {
  return (ENTITIES as readonly string[]).includes(s);
}

function isFormat(s: string): s is Format {
  return (FORMATS as readonly string[]).includes(s);
}
