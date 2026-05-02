// Vercel Cron entry point for the AI enquiry runner.
//
// Scheduled at 0 4 * * * by vercel.json — staggered behind
// import-tick (45 3) which is itself behind dsar-scrub (30 3) and
// deposit-janitor (0 3) so the four nightly jobs don't fight for
// connection slots.
//
// The cron is the BACKSTOP. Each enquiry's primary trigger is the
// inline `processEnquiry(id)` call from the inbound webhook
// (app/api/webhooks/resend-inbound/route.ts), which kicks the
// runner the moment the row lands so operators see drafts within
// seconds rather than waiting for the nightly tick. This route
// catches any enquiry whose inline kick failed (function timeout,
// transient parser error inside the 3-attempt budget) and re-runs
// it against the now-quieter system.
//
// One batch per tick — `limit: 10` is a generous upper bound for
// the spec's expected volume (a few hundred enquiries/month at
// launch).

import { NextResponse, type NextRequest } from "next/server";

import { processNextEnquiries } from "@/lib/enquiries/runner";

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

  const result = await processNextEnquiries({ limit: 10 });
  // Return only counts — the result objects carry enquiry ids
  // which are non-PII but can stay internal. Aggregate buckets
  // are enough for the cron's response body.
  const counts = {
    drafts: 0,
    discarded: 0,
    failed: 0,
    skipped: 0,
  };
  for (const r of result.processed) {
    if (r.status === "draft_ready") counts.drafts++;
    else if (r.status === "discarded") counts.discarded++;
    else if (r.status === "failed") counts.failed++;
    else counts.skipped++;
  }
  return NextResponse.json({ ok: true, ...counts });
}
