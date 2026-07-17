import { ChevronRight, Download } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LockedFeature } from "@/components/billing/locked-feature";
import { isLocked } from "@/lib/auth/entitlements";
import { hasPlan } from "@/lib/auth/plan-level";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import {
  CHANNEL_LABEL,
  OVERVIEW_WINDOW_DAYS,
  getMarketingOverview,
} from "@/lib/campaigns/overview";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const metadata = { title: "Marketing overview · TableKit" };

// Marketing overview dashboard (marketing-suite Part 2). Trailing-90-day
// roll-up across all of a venue's campaigns: performance by channel, top
// campaigns by booking conversion, and audience health. Plus-gated — the
// headline upsell ("see which emails filled tables") — enforced
// server-side here, not just hidden. Attribution capture runs for all
// tiers, so the funnel back-fills the moment a Core org upgrades.

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`;
}

function rate(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}

export default async function MarketingOverviewPage({
  params,
}: {
  params: Promise<{ venueId: string }>;
}) {
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

  // The whole page is the Plus upsell — gate before running the (heavier)
  // aggregate queries so Core orgs never pay for them.
  if (!hasPlan(plan, "plus")) {
    return (
      <section className="flex flex-col gap-6">
        <Header venueId={venueId} venueName={venue.name} plusUnlocked={false} />
        <div className="rounded-card border-coral/30 bg-coral/5 border p-6">
          <p className="text-charcoal text-sm">
            <span className="text-ink font-semibold">See which emails fill tables.</span> The
            marketing overview rolls up every campaign from the last {OVERVIEW_WINDOW_DAYS} days —
            sends, clicks and the bookings, covers and deposits each one generated — so you can see
            what actually works. Available on Plus.
          </p>
          <Link
            href="/dashboard/upgrade?feature=campaigns"
            className="bg-ink mt-4 inline-block rounded-md px-4 py-2 text-sm font-semibold text-white"
          >
            Upgrade to Plus
          </Link>
        </div>
      </section>
    );
  }

  const now = new Date();
  const overview = await withUser((db) => getMarketingOverview(db, venueId, now));

  const totals = overview.channels.reduce(
    (acc, c) => ({
      sends: acc.sends + c.sends,
      clicked: acc.clicked + c.clicked,
      bookings: acc.bookings + c.bookings,
      covers: acc.covers + c.covers,
    }),
    { sends: 0, clicked: 0, bookings: 0, covers: 0 },
  );

  const hasActivity = overview.channels.length > 0;

  return (
    <section className="flex flex-col gap-8">
      <Header venueId={venueId} venueName={venue.name} plusUnlocked />

      {!hasActivity ? (
        <div className="border-hairline rounded-card border bg-white p-6">
          <p className="text-ash text-sm">
            No campaigns sent in the last {OVERVIEW_WINDOW_DAYS} days.{" "}
            <Link
              href={`/dashboard/venues/${venueId}/campaigns`}
              className="text-ink font-semibold hover:underline"
            >
              Create a campaign
            </Link>{" "}
            to start filling this in.
          </p>
        </div>
      ) : (
        <>
          {/* Headline totals */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Sent" value={String(totals.sends)} />
            <Stat label="Clicked" value={String(totals.clicked)} />
            <Stat label="Bookings" value={String(totals.bookings)} />
            <Stat label="Covers" value={String(totals.covers)} />
          </div>

          {/* By channel */}
          <div>
            <h2 className="text-ink mb-3 text-base font-semibold">By channel</h2>
            <div className="border-hairline rounded-card overflow-x-auto border bg-white">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-cloud text-ash text-left text-xs font-semibold tracking-wider uppercase">
                  <tr>
                    <th className="px-4 py-2.5">Channel</th>
                    <th className="px-4 py-2.5">Campaigns</th>
                    <th className="px-4 py-2.5">Sent</th>
                    <th className="px-4 py-2.5">Delivered</th>
                    <th className="px-4 py-2.5">Opened†</th>
                    <th className="px-4 py-2.5">Clicked</th>
                    <th className="px-4 py-2.5">Bookings</th>
                    <th className="px-4 py-2.5">Covers</th>
                    <th className="px-4 py-2.5">Conv.</th>
                  </tr>
                </thead>
                <tbody className="divide-hairline divide-y">
                  {overview.channels.map((c) => {
                    const base = Math.max(c.delivered, c.sends);
                    return (
                      <tr key={c.channel}>
                        <td className="text-ink px-4 py-3 font-medium">
                          {CHANNEL_LABEL[c.channel]}
                        </td>
                        <td className="text-charcoal px-4 py-3">{c.campaigns}</td>
                        <td className="text-charcoal px-4 py-3">{c.sends}</td>
                        <td className="text-charcoal px-4 py-3">{c.delivered}</td>
                        <td className="text-charcoal px-4 py-3">
                          {c.channel === "email" ? `${c.opened} · ${pct(c.opened, base)}` : "—"}
                        </td>
                        <td className="text-charcoal px-4 py-3">
                          {c.clicked} · {pct(c.clicked, base)}
                        </td>
                        <td className="text-ink px-4 py-3 font-medium">{c.bookings}</td>
                        <td className="text-charcoal px-4 py-3">{c.covers}</td>
                        <td className="text-charcoal px-4 py-3">{pct(c.bookings, base)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-ash mt-2 text-xs">
              † Opens are inflated by Apple Mail&apos;s privacy protection — treat as directional.
              Clicks, bookings and covers are the reliable numbers. &ldquo;Conv.&rdquo; is bookings
              ÷ delivered (or sent, where the provider gives no delivery receipt).
            </p>
          </div>

          {/* Top campaigns by booking conversion */}
          <div>
            <h2 className="text-ink mb-3 text-base font-semibold">
              Top campaigns by booking conversion
            </h2>
            {overview.topCampaigns.length === 0 ? (
              <p className="text-ash text-sm">No sent campaigns in the window.</p>
            ) : (
              <div className="border-hairline rounded-card overflow-x-auto border bg-white">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="bg-cloud text-ash text-left text-xs font-semibold tracking-wider uppercase">
                    <tr>
                      <th className="px-4 py-2.5">Campaign</th>
                      <th className="px-4 py-2.5">Channel</th>
                      <th className="px-4 py-2.5">Delivered</th>
                      <th className="px-4 py-2.5">Clicked</th>
                      <th className="px-4 py-2.5">Bookings</th>
                      <th className="px-4 py-2.5">Covers</th>
                      <th className="px-4 py-2.5">Conv.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-hairline divide-y">
                    {overview.topCampaigns.map((c) => (
                      <tr key={c.id}>
                        <td className="px-4 py-3">
                          <Link
                            href={`/dashboard/venues/${venueId}/campaigns/${c.id}`}
                            className="text-ink font-medium hover:underline"
                          >
                            {c.name}
                          </Link>
                        </td>
                        <td className="text-charcoal px-4 py-3">{CHANNEL_LABEL[c.channel]}</td>
                        <td className="text-charcoal px-4 py-3">{c.delivered}</td>
                        <td className="text-charcoal px-4 py-3">{c.clicked}</td>
                        <td className="text-ink px-4 py-3 font-medium">{c.bookings}</td>
                        <td className="text-charcoal px-4 py-3">{c.covers}</td>
                        <td className="text-charcoal px-4 py-3">{rate(c.conversion)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Audience health */}
          <div>
            <h2 className="text-ink mb-3 text-base font-semibold">Audience health</h2>
            <div className="border-hairline rounded-card overflow-x-auto border bg-white">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-cloud text-ash text-left text-xs font-semibold tracking-wider uppercase">
                  <tr>
                    <th className="px-4 py-2.5">Channel</th>
                    <th className="px-4 py-2.5">Opted-in list</th>
                    <th className="px-4 py-2.5">New opt-ins ({OVERVIEW_WINDOW_DAYS}d)</th>
                    <th className="px-4 py-2.5">Unsubscribed</th>
                    <th className="px-4 py-2.5">Unsub. rate</th>
                  </tr>
                </thead>
                <tbody className="divide-hairline divide-y">
                  {overview.audience.map((a) => (
                    <tr key={a.channel}>
                      <td className="text-ink px-4 py-3 font-medium">{CHANNEL_LABEL[a.channel]}</td>
                      <td className="text-charcoal px-4 py-3">{a.consented}</td>
                      <td className="text-charcoal px-4 py-3">+{a.newOptIns}</td>
                      <td className="text-charcoal px-4 py-3">{a.unsubscribed}</td>
                      <td className="text-charcoal px-4 py-3">{rate(a.unsubRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-ash mt-2 text-xs">
              &ldquo;Opted-in list&rdquo; is the guests you can currently reach on each channel at
              this venue. &ldquo;New opt-ins&rdquo; counts consents given in the window. Unsub. rate
              is the share of the once-opted-in list that has since opted out (a current snapshot).
            </p>
          </div>
        </>
      )}
    </section>
  );
}

function Header({
  venueId,
  venueName,
  plusUnlocked,
}: {
  venueId: string;
  venueName: string;
  plusUnlocked: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <nav className="text-ash flex items-center gap-1.5 text-xs">
          <Link href={`/dashboard/venues/${venueId}/campaigns`} className="hover:text-ink">
            Campaigns
          </Link>
          <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
          <span className="text-ink">Overview</span>
        </nav>
        <h1 className="text-ink mt-2 text-2xl font-bold tracking-tight">Marketing overview</h1>
        <p className="text-ash mt-1 text-sm">
          Last {OVERVIEW_WINDOW_DAYS} days across all campaigns. {venueName}.
        </p>
      </div>
      {plusUnlocked ? (
        <a
          href={`/dashboard/venues/${venueId}/campaigns/reports/export`}
          className="border-hairline text-ink hover:bg-cloud inline-flex items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm font-medium"
        >
          <Download className="h-4 w-4" aria-hidden />
          Export CSV
        </a>
      ) : null}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-hairline rounded-card border bg-white p-4">
      <p className="text-ash text-xs font-semibold tracking-wider uppercase">{label}</p>
      <p className="text-ink mt-1 text-xl font-bold">{value}</p>
      {sub ? <p className="text-ash mt-0.5 text-xs">{sub}</p> : null}
    </div>
  );
}
