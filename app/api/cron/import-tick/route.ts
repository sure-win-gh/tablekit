// Vercel Cron entry point for the bulk-import runner.
//
// Scheduled at 45 3 * * * by vercel.json — staggered behind
// dsar-scrub (30 3) which is itself behind deposit-janitor (0 3) so
// the three nightly jobs don't fight for connection slots.
//
// The cron is a backstop: the upload action (PR4) will trigger the
// runner inline immediately on operator submit, so the operator
// doesn't wait until 3am for their import to start. This route is
// what catches a stuck job — failed mid-import on a function timeout,
// stuck in 'queued' because the inline call errored before reaching
// the runner, etc.
//
// One job per tick. Spec's 50k-row target fits comfortably inside
// the Vercel Hobby 60s function timeout for a typical CSV.

import { NextResponse, type NextRequest } from "next/server";

import { processNextImportJob } from "@/lib/import/runner/writer";

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

  const { jobId, result } = await processNextImportJob();
  return NextResponse.json({
    ok: true,
    jobId,
    result,
  });
}
