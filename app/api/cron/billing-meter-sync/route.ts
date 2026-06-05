// Vercel Cron entry point for the transactional usage → Stripe meter sync.
//
// Reports the day's new transactional SMS/WhatsApp pass-through cost to the
// Stripe Billing Meter so it lands on the monthly subscription invoice.
// No-ops cleanly until Stripe + the Meter are configured.

import { NextResponse, type NextRequest } from "next/server";

import { reportUsageDeltas } from "@/lib/billing/meter-sync";

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

  const result = await reportUsageDeltas(new Date());
  return NextResponse.json({ ok: true, ...result });
}
