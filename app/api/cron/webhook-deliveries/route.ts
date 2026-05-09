// Vercel Cron entry point for outbound webhook delivery + retry.
//
// Picks up pending deliveries due to fire (next_attempt_at <= now())
// and POSTs them via lib/webhooks/deliver.ts. Failure → exponential
// backoff (1m / 5m / 30m / 4h / 24h) up to 5 attempts, then `failed`.
//
// Schedule: currently `30 4 * * *` (once daily) because Vercel Hobby
// tier disallows sub-daily cron frequencies. The retry backoff in
// lib/webhooks/deliver.ts assumes a ~5-minute tick (1m retry, 5m
// retry, etc.); on Hobby a "1-minute retry" actually waits up to
// ~24h until the next tick. Webhooks still deliver and retry, just
// with much longer latency.
//
// On upgrade to Pro: change vercel.json to `*/5 * * * *` so the
// retry backoff fires at the cadence the helper was designed for.
// No code change required — the cron route is identical.

import { NextResponse, type NextRequest } from "next/server";

import { processNextDeliveries } from "@/lib/webhooks/deliver";

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

  const result = await processNextDeliveries({ limit: 50 });
  const counts = { succeeded: 0, retry: 0, failed: 0 };
  for (const r of result.processed) {
    if (r.kind === "succeeded") counts.succeeded++;
    else if (r.kind === "retry") counts.retry++;
    else if (r.kind === "failed") counts.failed++;
  }
  return NextResponse.json({ ok: true, ...counts });
}
