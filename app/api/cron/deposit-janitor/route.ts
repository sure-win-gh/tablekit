// Vercel Cron entry point for the deposit-abandonment janitor.
//
// Scheduled at */5 * * * * by vercel.json. Vercel Cron invokes this
// route with an `Authorization: Bearer ${CRON_SECRET}` header — we
// refuse any call without a matching secret so nobody can poke the
// endpoint manually to trigger sweeps.

import { NextResponse, type NextRequest } from "next/server";

import { sweepAbandonedDeposits } from "@/lib/payments/janitor";

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

  const result = await sweepAbandonedDeposits();
  return NextResponse.json({ ok: true, ...result });
}
