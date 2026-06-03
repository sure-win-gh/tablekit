// Vercel Cron entry point for the campaign-send retention sweep.
//
// Hard-deletes campaign_sends rows older than the retention window
// (24 months) — removing guest-linked engagement (opens/clicks). The
// parent campaigns' aggregate counts are retained.

import { NextResponse, type NextRequest } from "next/server";

import { sweepCampaignSendRetention } from "@/lib/campaigns/retention";

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

  const result = await sweepCampaignSendRetention();
  return NextResponse.json({ ok: true, ...result });
}
