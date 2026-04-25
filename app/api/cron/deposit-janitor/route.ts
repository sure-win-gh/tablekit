// Vercel Cron entry point for nightly payments maintenance.
//
// Scheduled at 0 3 * * * by vercel.json (Hobby tier caps cron freq at
// once per day). The route name is historical — it now does two jobs
// in sequence, both idempotent + safe to run together:
//
//   1. Deposit-abandonment janitor — cancels stuck `requested`
//      bookings + their PaymentIntents (flow A).
//   2. No-show capture sweeper — charges card-hold deposits that
//      didn't seat by start_at + 30min (flow B).
//
// Both are also driven inline at the start of POST /api/v1/bookings
// (janitor, venue-scoped) and on the bookings list page load
// (no-show, venue-scoped) for near-real-time during operating hours.
// This route is the unconditional backstop.

import { NextResponse, type NextRequest } from "next/server";

import { processNextBatch } from "@/lib/messaging/dispatch";
import { sweepAbandonedDeposits } from "@/lib/payments/janitor";
import { sweepDueNoShowCaptures } from "@/lib/payments/no-show";

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

  const janitor = await sweepAbandonedDeposits();
  const noShow = await sweepDueNoShowCaptures();
  // Drain whatever messaging work is due. 200 rows is a generous cap;
  // each send is ~500ms, well under Vercel's function timeout.
  const messages = await processNextBatch({ limit: 200 });
  return NextResponse.json({
    ok: true,
    abandonment: janitor,
    noShow,
    messages,
  });
}
