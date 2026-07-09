import { desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { LockedFeature } from "@/components/billing/locked-feature";
import { isLocked } from "@/lib/auth/entitlements";
import { hasPlan } from "@/lib/auth/plan-level";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { getBalance } from "@/lib/billing/credit";
import { getEmailAllowanceState, isEmailOverageEnforced } from "@/lib/billing/email-allowance";
import {
  MARKETING_EMAIL,
  emailCampaignCostPence,
  emailChargeableCount,
} from "@/lib/billing/marketing-email";
import { CHANNEL_COST_PENCE } from "@/lib/billing/usage";
import { estimateAudience } from "@/lib/campaigns/recipients";
import { MARKETING_TAG_NAMES } from "@/lib/campaigns/render";
import { withUser } from "@/lib/db/client";
import { campaigns, venues } from "@/lib/db/schema";
import { SEGMENTS, SEGMENT_LABEL } from "@/lib/guests/segments";
import { parseBranding } from "@/lib/messaging/venue-settings";

import { ChannelTabs } from "./channel-tabs";

export const metadata = { title: "Campaigns · TableKit" };

export default async function CampaignsPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { orgId } = await requireRole("manager");
  const { venueId } = await params;

  const plan = await getPlan(orgId);
  if (isLocked(plan, "campaigns")) {
    return <LockedFeature feature="campaigns" currentPlan={plan} />;
  }

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id, name: venues.name, settings: venues.settings })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();
  const brandColour = parseBranding(venue.settings)?.brandColour ?? null;

  // Initial consent-filtered estimate for the default (email, all), with
  // the plan's allowance applied. The composer refetches per
  // (channel, segment) on change.
  const audience = await estimateAudience(orgId, venueId, "email", { segment: "all" });
  const allowanceState = await getEmailAllowanceState(orgId, plan, new Date());
  const initialEstimate = {
    count: audience.count,
    costPence: emailCampaignCostPence(
      audience.count,
      allowanceState.remaining,
      MARKETING_EMAIL.overagePencePer1000[plan],
    ),
    emailBilling: {
      ...allowanceState,
      chargeable: emailChargeableCount(audience.count, allowanceState.remaining),
      enforced: isEmailOverageEnforced(),
    },
  };
  const initialBalancePence = await withUser((db) => getBalance(db, orgId));
  const segments = SEGMENTS.map((key) => ({ key, label: SEGMENT_LABEL[key] }));
  const plusUnlocked = hasPlan(plan, "plus");

  const list = await withUser(async (db) =>
    db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        channel: campaigns.channel,
        status: campaigns.status,
        counts: campaigns.counts,
        createdAt: campaigns.createdAt,
      })
      .from(campaigns)
      .where(eq(campaigns.venueId, venueId))
      .orderBy(desc(campaigns.createdAt))
      .limit(50),
  );

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h1 className="text-ink text-2xl font-bold tracking-tight">Campaigns</h1>
        <p className="text-ash mt-1 text-sm">
          Promote events and offers to guests who opted in. {venue.name}.
        </p>
      </div>

      <ChannelTabs
        venueId={venue.id}
        brandColour={brandColour}
        plan={plan}
        segments={segments}
        canSegment={plusUnlocked}
        plusUnlocked={plusUnlocked}
        initialEstimate={initialEstimate}
        initialBalancePence={initialBalancePence}
        mergeTags={[...MARKETING_TAG_NAMES]}
        channelCostPence={CHANNEL_COST_PENCE}
        emailAllowanceRemaining={allowanceState.remaining}
        recent={list.map((c) => {
          const counts = (c.counts ?? {}) as Record<string, number>;
          return {
            id: c.id,
            name: c.name,
            channel: c.channel,
            status: c.status,
            sent: counts["sent"] ?? 0,
            opened: counts["opened"] ?? 0,
          };
        })}
      />
    </section>
  );
}
