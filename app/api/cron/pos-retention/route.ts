// Vercel Cron entry for the POS order retention sweep. Hard-deletes
// pos_orders past each org's window (pos_retention_months ?? 24), in bounded
// batches, recomputing affected guest spend. Mirrors enquiry-retention.

import { NextResponse, type NextRequest } from "next/server";

import { sweepExpiredPosOrders } from "@/lib/pos/retention";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const expected = process.env["CRON_SECRET"];
  if (!expected || expected.includes("YOUR_")) {
    return NextResponse.json({ error: "server-misconfigured" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const result = await sweepExpiredPosOrders();
  return NextResponse.json({ ok: true, ...result });
}
