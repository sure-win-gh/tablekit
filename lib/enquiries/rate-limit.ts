// Per-org + per-sender rate limit on Bedrock parser invocations.
//
// Two layered buckets, BOTH must permit the call:
//
//   org-budget    — `enquiry:org:<orgId>` — max ENQUIRIES_PER_ORG_PER_HOUR
//                   parses per hour for any single org. Bounds Bedrock
//                   cost per Plus tenant. 100/h is generous against
//                   plausible enquiry volumes (a busy independent
//                   handles ~50/day) and keeps a runaway cron from
//                   torching the bill.
//
//   sender-bucket — `enquiry:sender:<orgId>:<fromEmailHash>` — max
//                   ENQUIRIES_PER_SENDER_PER_HOUR parses per hour from
//                   any single sender to any single org. Anti-abuse:
//                   blocks a malicious sender from spamming a single
//                   venue. 5/h covers the legitimate "follow-up"
//                   pattern with comfortable headroom; anything above
//                   that looks like harassment or automation.
//
// Checked PRE-CLAIM in the runner so a rate-limit reject doesn't
// bump `parse_attempts` (the cap on Bedrock-call retries) or
// transition the row through 'parsing'. The row stays at 'received'
// and the cron picks it up on the next tick once the window has
// rolled.
//
// Upstash outages fall open — see lib/public/rate-limit.ts. The UX
// of refusing legitimate enquiries during a Redis blip is worse than
// the over-spend risk for our scale.

import "server-only";

import { rateLimit } from "@/lib/public/rate-limit";

// Tunables. Hourly windows align with cost-bounding intuition;
// shorter would be punitive on legitimate burst patterns.
const ENQUIRIES_PER_ORG_PER_HOUR = 100;
const ENQUIRIES_PER_SENDER_PER_HOUR = 5;
const WINDOW_SEC = 60 * 60;

export type EnquiryRateLimitResult =
  | { ok: true }
  | { ok: false; bucket: "org" | "sender"; retryAfterSec: number };

export async function checkEnquiryRateLimit(
  orgId: string,
  fromEmailHash: string,
): Promise<EnquiryRateLimitResult> {
  // Order matters: check the per-org budget first so a legitimate
  // sender doesn't get blamed for the org's overall cap. The two
  // checks are independent (no aggregation), so callers see
  // whichever bucket failed.
  const orgResult = await rateLimit(`enquiry:org:${orgId}`, ENQUIRIES_PER_ORG_PER_HOUR, WINDOW_SEC);
  if (!orgResult.ok) {
    return {
      ok: false,
      bucket: "org",
      retryAfterSec: orgResult.retryAfterSec ?? WINDOW_SEC,
    };
  }

  const senderResult = await rateLimit(
    `enquiry:sender:${orgId}:${fromEmailHash}`,
    ENQUIRIES_PER_SENDER_PER_HOUR,
    WINDOW_SEC,
  );
  if (!senderResult.ok) {
    return {
      ok: false,
      bucket: "sender",
      retryAfterSec: senderResult.retryAfterSec ?? WINDOW_SEC,
    };
  }

  return { ok: true };
}

// Exposed for tests + potential future per-org dashboards.
export const ENQUIRY_RATE_LIMIT = {
  ENQUIRIES_PER_ORG_PER_HOUR,
  ENQUIRIES_PER_SENDER_PER_HOUR,
  WINDOW_SEC,
} as const;
