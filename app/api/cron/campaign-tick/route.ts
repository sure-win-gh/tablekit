// Vercel Cron entry point for the marketing-campaign dispatch worker.
//
// The cron is the BACKSTOP. Send-now drives the worker inline so the
// first batch lands within seconds; scheduled campaigns (and any rows
// whose inline drive failed or didn't finish the whole list) are picked
// up here. One generous batch per tick.

import { NextResponse, type NextRequest } from "next/server";

import { processNextCampaignBatch } from "@/lib/campaigns/dispatch";

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

  const result = await processNextCampaignBatch({ limit: 200 });
  return NextResponse.json({ ok: true, ...result });
}
