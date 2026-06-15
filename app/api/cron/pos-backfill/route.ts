// Vercel Cron entry for the POS historical backfill runner. Bounded +
// resumable: pulls order history for newly-connected venues a page at a time
// across ticks. The live webhook path does not depend on this.

import { NextResponse, type NextRequest } from "next/server";

import { runPosBackfill } from "@/lib/pos/backfill";

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

  const result = await runPosBackfill();
  return NextResponse.json({ ok: true, ...result });
}
