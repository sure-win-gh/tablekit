// CSV export for the current financials snapshot.
//
//   GET /admin/export/financials
//
// One row per Stripe tier plus a TOTAL row summarising MRR + active
// subscription count. Snapshot semantics — the underlying
// `getMrrSnapshot()` is the same 5-minute cache the financials page
// reads, so a freshly downloaded CSV matches the on-screen tile.
//
// When Stripe degrades (`reason !== "ok"`) we still ship a row so
// the spreadsheet doesn't go empty; the row carries the degraded
// reason in a column so the founder can spot stale data downstream.

import { NextResponse } from "next/server";

import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { toCsv } from "@/lib/server/admin/dashboard/csv";
import { getMrrSnapshot } from "@/lib/server/admin/dashboard/stripe-billing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = {
  tier: string;
  mrrMinor: number;
  activeSubs: number;
  asOf: string;
  reason: string;
};

export async function GET(): Promise<NextResponse> {
  const session = await requirePlatformAdmin();

  const snapshot = await getMrrSnapshot();

  const tierRows: Row[] = Object.entries(snapshot.byTier).map(([tier, mrrMinor]) => ({
    tier,
    mrrMinor,
    // Per-tier active-subs count isn't surfaced by the snapshot;
    // 0 here means "not broken out" rather than "no subs on tier".
    activeSubs: 0,
    asOf: snapshot.asOf.toISOString(),
    reason: snapshot.reason,
  }));
  const totalRow: Row = {
    tier: "TOTAL",
    mrrMinor: snapshot.mrrMinor,
    activeSubs: snapshot.activeSubs,
    asOf: snapshot.asOf.toISOString(),
    reason: snapshot.reason,
  };
  const rows: Row[] = [...tierRows, totalRow];

  await platformAudit.log({
    actorEmail: session.email,
    action: "exported",
    metadata: {
      metric: "financials",
      count: rows.length,
      reason: snapshot.reason,
    },
  });

  const csv = toCsv(rows, [
    { header: "tier", value: (r) => r.tier },
    { header: "mrr_minor", value: (r) => r.mrrMinor },
    { header: "active_subs", value: (r) => r.activeSubs },
    { header: "as_of", value: (r) => r.asOf },
    { header: "stripe_status", value: (r) => r.reason },
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="financials-${stamp}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}
