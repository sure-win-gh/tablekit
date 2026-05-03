// Vercel Cron entry point for the enquiry retention sweeper.
//
// Scheduled at 15 4 * * * by vercel.json — staggered behind
// enquiry-tick (0 4) so the runner finishes its drain before the
// retention sweep runs. Whole nightly sequence:
//   0  3 — deposit-janitor
//   30 3 — dsar-scrub
//   45 3 — import-tick
//   0  4 — enquiry-tick (parser drain)
//   15 4 — enquiry-retention (this)
//
// Hard-deletes any enquiry where received_at < now - 90 days, in
// batches of 1000. A backlog larger than 1000 drains over multiple
// nights — that's fine, the GDPR commitment is "purged within 90
// days" and our trigger is at exactly 90 days, so a few days of
// catch-up on a fresh deploy is well inside compliance.

import { NextResponse, type NextRequest } from "next/server";

import { sweepExpiredEnquiries } from "@/lib/enquiries/retention";

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

  const result = await sweepExpiredEnquiries();
  return NextResponse.json({ ok: true, ...result });
}
