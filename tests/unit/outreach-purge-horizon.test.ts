// Consistency check: the purge horizon must equal the claim-token
// TTL. If one drifts without the other, either claim links 404 before
// the org is purged (user-facing breakage) or unclaimed orgs hang
// around past their advertised lifetime (privacy + storage drift).
// Cheap test, catches a footgun.

import { describe, expect, it } from "vitest";

import { CLAIM_DEFAULT_TTL_MS } from "@/lib/outreach/claim-token";
import { PURGE_HORIZON_DAYS } from "@/lib/outreach/purge-unclaimed";

describe("outreach retention constants", () => {
  it("PURGE_HORIZON_DAYS matches CLAIM_DEFAULT_TTL_MS", () => {
    expect(PURGE_HORIZON_DAYS * 24 * 60 * 60 * 1000).toBe(CLAIM_DEFAULT_TTL_MS);
  });
});
