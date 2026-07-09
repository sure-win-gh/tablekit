// Vercel Cron entry point for click-window campaign attribution
// (marketing-suite Phase B).
//
// Nightly: stamps attribution_kind='click_window' on recent unattributed
// bookings whose guest clicked a campaign email for the same venue within
// the 7-day window. Link-attributed bookings are never touched.

import { NextResponse, type NextRequest } from "next/server";

import { attributeClickWindowBookings } from "@/lib/campaigns/attribution";

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

  const result = await attributeClickWindowBookings(new Date());
  return NextResponse.json({ ok: true, ...result });
}
