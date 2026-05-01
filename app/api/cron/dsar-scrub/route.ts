// Vercel Cron entry point for the DSAR erasure scrub.
//
// Scheduled at 30 3 * * * by vercel.json — 30 minutes after the
// deposit-janitor so the two cron jobs don't fight for connections.
// The privacy-requests dashboard page also calls the sweeper inline
// (best-effort) so an operator who marks a request completed and
// refreshes sees the scrub already done; this route is the
// unconditional backstop.

import { NextResponse, type NextRequest } from "next/server";

import { sweepCompletedErasureScrubs } from "@/lib/dsar/sweep";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const expected = process.env["CRON_SECRET"];
  if (!expected || expected.includes("YOUR_")) {
    return NextResponse.json({ error: "server-misconfigured" }, { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const result = await sweepCompletedErasureScrubs({ limit: 50 });
  return NextResponse.json({ ok: true, dsarScrub: result });
}
