// Feature-adoption rates across the platform.
//
// Each row is "% of organisations using <feature>", computed as
// distinct organisation_id count over the relevant table divided by
// total organisations. Used by /admin/feature-adoption to read off
// which features earn their keep.
//
// Plus a venue-type mix breakdown (cafe / restaurant / bar_pub) — a
// useful marketing signal but not a feature-adoption rate per se.

import "server-only";

import { count, countDistinct, eq, isNotNull, isNull, sql } from "drizzle-orm";

import {
  apiKeys,
  campaigns,
  depositRules,
  enquiries,
  importJobs,
  messages,
  organisations,
  posConnections,
  reviews,
  stripeAccounts,
  venues,
  waitlists,
} from "@/lib/db/schema";

import type { AdminDb } from "../types";

export type FeatureAdoption = {
  totalOrgs: number;
  features: { key: string; label: string; orgsWithFeature: number }[];
  venueTypeMix: { venueType: string; count: number }[];
};

export async function getFeatureAdoption(db: AdminDb): Promise<FeatureAdoption> {
  const [
    totalRow,
    depositRuleOrgs,
    waitlistOrgs,
    multiVenueOrgs,
    reviewsOrgs,
    connectCompleteOrgs,
    anyMessageOrgs,
    multiMemberOrgs,
    enquiryOrgs,
    campaignSentOrgs,
    posOrgs,
    importOrgs,
    apiKeyOrgs,
    venueTypeRows,
  ] = await Promise.all([
    db.select({ n: count() }).from(organisations),
    db.select({ n: countDistinct(depositRules.organisationId) }).from(depositRules),
    db.select({ n: countDistinct(waitlists.organisationId) }).from(waitlists),
    db.execute<{ n: string | number }>(sql`
      select count(*)::int as n from (
        select organisation_id from venues group by organisation_id having count(*) >= 2
      ) s
    `),
    db.select({ n: countDistinct(reviews.organisationId) }).from(reviews),
    db.select({ n: count() }).from(stripeAccounts).where(eq(stripeAccounts.payoutsEnabled, true)),
    db.select({ n: countDistinct(messages.organisationId) }).from(messages),
    db.execute<{ n: string | number }>(sql`
      select count(*)::int as n from (
        select organisation_id from memberships group by organisation_id having count(*) >= 2
      ) s
    `),
    db.select({ n: countDistinct(enquiries.organisationId) }).from(enquiries),
    db
      .select({ n: countDistinct(campaigns.organisationId) })
      .from(campaigns)
      .where(isNotNull(campaigns.sentAt)),
    db
      .select({ n: countDistinct(posConnections.organisationId) })
      .from(posConnections)
      .where(eq(posConnections.status, "active")),
    db.select({ n: countDistinct(importJobs.organisationId) }).from(importJobs),
    db
      .select({ n: countDistinct(apiKeys.organisationId) })
      .from(apiKeys)
      .where(isNull(apiKeys.revokedAt)),
    db
      .select({
        venueType: venues.venueType,
        count: count(),
      })
      .from(venues)
      .groupBy(venues.venueType),
  ]);

  const totalOrgs = totalRow[0]?.n ?? 0;

  const features: FeatureAdoption["features"] = [
    { key: "deposit_rules", label: "≥1 deposit rule", orgsWithFeature: depositRuleOrgs[0]?.n ?? 0 },
    { key: "waitlist", label: "≥1 waitlist entry", orgsWithFeature: waitlistOrgs[0]?.n ?? 0 },
    {
      key: "multi_venue",
      label: "Multi-venue (≥2 venues)",
      orgsWithFeature: Number(multiVenueOrgs.rows[0]?.n ?? 0),
    },
    { key: "reviews", label: "Reviews ingested", orgsWithFeature: reviewsOrgs[0]?.n ?? 0 },
    {
      key: "connect_payouts",
      label: "Stripe Connect payouts enabled",
      orgsWithFeature: connectCompleteOrgs[0]?.n ?? 0,
    },
    { key: "any_message", label: "Sent ≥1 message", orgsWithFeature: anyMessageOrgs[0]?.n ?? 0 },
    {
      key: "multi_member",
      label: "≥2 team members",
      orgsWithFeature: Number(multiMemberOrgs.rows[0]?.n ?? 0),
    },
    {
      key: "enquiries",
      label: "AI enquiry handler (≥1 enquiry)",
      orgsWithFeature: enquiryOrgs[0]?.n ?? 0,
    },
    {
      key: "campaigns",
      label: "Sent ≥1 marketing campaign",
      orgsWithFeature: campaignSentOrgs[0]?.n ?? 0,
    },
    { key: "pos", label: "POS connected", orgsWithFeature: posOrgs[0]?.n ?? 0 },
    { key: "imports", label: "Ran ≥1 guest import", orgsWithFeature: importOrgs[0]?.n ?? 0 },
    {
      key: "api_keys",
      label: "Public API key (unrevoked)",
      orgsWithFeature: apiKeyOrgs[0]?.n ?? 0,
    },
  ];

  return {
    totalOrgs,
    features,
    venueTypeMix: venueTypeRows.map((r) => ({ venueType: r.venueType, count: r.count })),
  };
}
