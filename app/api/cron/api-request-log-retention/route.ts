// Vercel Cron entry point for the API request log retention sweep.
//
// Hard-deletes api_request_log rows older than 90 days. Same auth
// pattern as the other crons (Bearer CRON_SECRET).
//
// Scheduled at 45 4 * * * after webhook-deliveries (30 4) so the
// nightly window stays predictable. The created_at index makes
// the WHERE cheap; a single DELETE handles whatever lands.

import { NextResponse, type NextRequest } from "next/server";

import { sweepExpiredRequestLog } from "@/lib/api/v1/request-log";

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

  const result = await sweepExpiredRequestLog();
  return NextResponse.json({ ok: true, ...result });
}
