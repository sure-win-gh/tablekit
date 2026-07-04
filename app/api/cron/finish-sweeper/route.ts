// Vercel Cron entry point for the auto-finish backstop.
//
// Scheduled at 15 3 * * * by vercel.json (Hobby tier caps cron freq
// at once per day). Finishes any still-"seated" booking whose booked
// end passed 3+ hours ago, per-venue gated on
// settings.serviceFlow.autoFinishEnabled. The near-real-time path is
// the venue-scoped inline sweep run by the overdue-poll server action
// whenever a dashboard is open; this route is the unconditional
// backstop for venues nobody has open overnight.
// See docs/specs/service-flow.md.

import { NextResponse, type NextRequest } from "next/server";

import { sweepAllStaleSeated } from "@/lib/bookings/finish-sweep";

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

  const result = await sweepAllStaleSeated();
  return NextResponse.json({ ok: true, ...result });
}
