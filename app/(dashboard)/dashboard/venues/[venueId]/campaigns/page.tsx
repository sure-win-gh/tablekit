import { desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { LockedFeature } from "@/components/billing/locked-feature";
import { isLocked } from "@/lib/auth/entitlements";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { getBalance } from "@/lib/billing/credit";
import { estimateAudience } from "@/lib/campaigns/recipients";
import { MARKETING_TAG_NAMES } from "@/lib/campaigns/render";
import { withUser } from "@/lib/db/client";
import { campaigns, venues } from "@/lib/db/schema";
import { SEGMENTS, SEGMENT_LABEL } from "@/lib/guests/segments";

import { CampaignComposer } from "./campaign-composer";

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
      .select({ id: venues.id, name: venues.name })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();

  // Initial consent-filtered estimate for the default (email, all). The
  // composer refetches per (channel, segment) on change.
  const initialEstimate = await estimateAudience(orgId, venueId, "email", { segment: "all" });
  const initialBalancePence = await withUser((db) => getBalance(db, orgId));
  const segments = SEGMENTS.map((key) => ({ key, label: SEGMENT_LABEL[key] }));

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

      <CampaignComposer
        venueId={venue.id}
        segments={segments}
        initialEstimate={initialEstimate}
        initialBalancePence={initialBalancePence}
        mergeTags={[...MARKETING_TAG_NAMES]}
      />

      <div>
        <h2 className="text-ink mb-3 text-base font-semibold">Recent campaigns</h2>
        {list.length === 0 ? (
          <p className="text-ash text-sm">No campaigns yet.</p>
        ) : (
          <div className="border-hairline rounded-card overflow-hidden border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-cloud text-ash text-left text-xs font-semibold tracking-wider uppercase">
                <tr>
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Channel</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Sent</th>
                  <th className="px-4 py-2.5">Opened</th>
                </tr>
              </thead>
              <tbody className="divide-hairline divide-y">
                {list.map((c) => {
                  const counts = (c.counts ?? {}) as Record<string, number>;
                  return (
                    <tr key={c.id}>
                      <td className="text-ink px-4 py-3 font-medium">{c.name}</td>
                      <td className="text-charcoal px-4 py-3">{c.channel}</td>
                      <td className="text-charcoal px-4 py-3">{c.status}</td>
                      <td className="text-charcoal px-4 py-3">{counts["sent"] ?? 0}</td>
                      <td className="text-charcoal px-4 py-3">{counts["opened"] ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
