import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LockedFeature } from "@/components/billing/locked-feature";
import { isLocked } from "@/lib/auth/entitlements";
import { hasPlan } from "@/lib/auth/plan-level";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { bookings, campaignLinkClicks, campaignSends, campaigns, payments } from "@/lib/db/schema";

export const metadata = { title: "Campaign report · TableKit" };

// Per-campaign report (marketing-suite Phase B). Basic delivery stats are
// Core+ (the campaigns feature gate); the booking-attribution funnel is
// the Plus headline. All reads go through withUser → RLS org-scopes them.

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`;
}

function money(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

export default async function CampaignReportPage({
  params,
}: {
  params: Promise<{ venueId: string; campaignId: string }>;
}) {
  const { orgId } = await requireRole("manager");
  const { venueId, campaignId } = await params;

  const plan = await getPlan(orgId);
  if (isLocked(plan, "campaigns")) {
    return <LockedFeature feature="campaigns" currentPlan={plan} />;
  }
  const plusUnlocked = hasPlan(plan, "plus");

  const campaign = await withUser(async (db) => {
    const rows = await db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        channel: campaigns.channel,
        status: campaigns.status,
        segment: campaigns.segment,
        sentAt: campaigns.sentAt,
        createdAt: campaigns.createdAt,
      })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.venueId, venueId)))
      .limit(1);
    return rows[0];
  });
  if (!campaign) notFound();

  // Live funnel from the send rows (truthful; `counts` jsonb is a cache).
  const funnel = await withUser(async (db) => {
    const [row] = await db
      .select({
        queued: sql<number>`count(*)::int`,
        sent: sql<number>`count(*) filter (where ${campaignSends.sentAt} is not null)::int`,
        delivered: sql<number>`count(*) filter (where ${campaignSends.status} = 'delivered')::int`,
        opened: sql<number>`count(*) filter (where ${campaignSends.openedAt} is not null)::int`,
        clicked: sql<number>`count(*) filter (where ${campaignSends.clickedAt} is not null)::int`,
        failed: sql<number>`count(*) filter (where ${campaignSends.status} in ('failed','bounced'))::int`,
      })
      .from(campaignSends)
      .where(eq(campaignSends.campaignId, campaignId));
    return row ?? { queued: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, failed: 0 };
  });
  // Providers without delivery receipts (or pre-webhook) leave status at
  // 'sent' — use the larger of the two so rates aren't divided by zero.
  const deliveredBase = Math.max(funnel.delivered, funnel.sent);

  const failures = await withUser((db) =>
    db
      .select({
        id: campaignSends.id,
        status: campaignSends.status,
        error: campaignSends.error,
        updatedAt: campaignSends.updatedAt,
      })
      .from(campaignSends)
      .where(
        and(
          eq(campaignSends.campaignId, campaignId),
          inArray(campaignSends.status, ["failed", "bounced"]),
        ),
      )
      .orderBy(desc(campaignSends.updatedAt))
      .limit(10),
  );

  // Booking attribution (Plus). Cancelled bookings excluded from the
  // headline; deposits = succeeded deposit payments on attributed bookings.
  const attribution = plusUnlocked
    ? await withUser(async (db) => {
        const [agg] = await db
          .select({
            bookings: sql<number>`count(*) filter (where ${bookings.status} <> 'cancelled')::int`,
            covers: sql<number>`coalesce(sum(${bookings.partySize}) filter (where ${bookings.status} <> 'cancelled'), 0)::int`,
            viaLink: sql<number>`count(*) filter (where ${bookings.attributionKind} = 'link' and ${bookings.status} <> 'cancelled')::int`,
            viaClickWindow: sql<number>`count(*) filter (where ${bookings.attributionKind} = 'click_window' and ${bookings.status} <> 'cancelled')::int`,
            cancelled: sql<number>`count(*) filter (where ${bookings.status} = 'cancelled')::int`,
          })
          .from(bookings)
          .where(eq(bookings.campaignId, campaignId));
        const [dep] = await db
          .select({
            pence: sql<number>`coalesce(sum(${payments.amountMinor}), 0)::int`,
          })
          .from(payments)
          .innerJoin(bookings, eq(bookings.id, payments.bookingId))
          .where(
            and(
              eq(bookings.campaignId, campaignId),
              isNotNull(bookings.attributionKind),
              eq(payments.kind, "deposit"),
              eq(payments.status, "succeeded"),
            ),
          );
        return {
          ...(agg ?? { bookings: 0, covers: 0, viaLink: 0, viaClickWindow: 0, cancelled: 0 }),
          depositPence: dep?.pence ?? 0,
        };
      })
    : null;

  const isEmail = campaign.channel === "email";

  // Link-level clicks (Phase C, Core+ engagement detail). Each row is a
  // unique (send, url), so count(*) per url = unique clickers. Email only.
  const topLinks = isEmail
    ? await withUser((db) =>
        db
          .select({
            url: campaignLinkClicks.url,
            clickers: sql<number>`count(*)::int`,
          })
          .from(campaignLinkClicks)
          .where(eq(campaignLinkClicks.campaignId, campaignId))
          .groupBy(campaignLinkClicks.url)
          .orderBy(desc(sql`count(*)`))
          .limit(15),
      )
    : [];

  return (
    <section className="flex flex-col gap-8">
      <div>
        <nav className="text-ash flex items-center gap-1.5 text-xs">
          <Link href={`/dashboard/venues/${venueId}/campaigns`} className="hover:text-ink">
            Campaigns
          </Link>
          <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
          <span className="text-ink">{campaign.name}</span>
        </nav>
        <h1 className="text-ink mt-2 text-2xl font-bold tracking-tight">{campaign.name}</h1>
        <p className="text-ash mt-1 text-sm">
          {campaign.channel} · {campaign.status} · audience: {campaign.segment}
          {campaign.sentAt
            ? ` · sent ${campaign.sentAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`
            : ""}
        </p>
      </div>

      {/* Delivery + engagement (Core+) */}
      <div>
        <h2 className="text-ink mb-3 text-base font-semibold">Delivery &amp; engagement</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Queued" value={String(funnel.queued)} />
          <Stat label="Sent" value={String(funnel.sent)} sub={pct(funnel.sent, funnel.queued)} />
          <Stat
            label="Delivered"
            value={String(funnel.delivered)}
            sub={pct(funnel.delivered, funnel.sent)}
          />
          {isEmail ? (
            <Stat
              label="Opened†"
              value={String(funnel.opened)}
              sub={pct(funnel.opened, deliveredBase)}
            />
          ) : null}
          {isEmail ? (
            <Stat
              label="Clicked"
              value={String(funnel.clicked)}
              sub={pct(funnel.clicked, deliveredBase)}
            />
          ) : null}
          <Stat label="Failed" value={String(funnel.failed)} />
        </div>
        {isEmail ? (
          <p className="text-ash mt-2 text-xs">
            † Opens are inflated by Apple Mail&apos;s privacy protection (it auto-loads emails for
            many guests) — treat them as directional. Clicks and bookings are the reliable numbers.
          </p>
        ) : null}
      </div>

      {/* Bookings funnel (Plus) */}
      {attribution ? (
        <div>
          <h2 className="text-ink mb-3 text-base font-semibold">Bookings from this campaign</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Bookings"
              value={String(attribution.bookings)}
              sub={`${pct(attribution.bookings, deliveredBase)} of delivered`}
            />
            <Stat label="Covers" value={String(attribution.covers)} />
            <Stat label="Deposits taken" value={money(attribution.depositPence)} />
            <Stat
              label="Attribution"
              value={`${attribution.viaLink} · ${attribution.viaClickWindow}`}
              sub="via link · via click-window"
            />
          </div>
          <p className="text-ash mt-2 text-xs">
            &ldquo;Via link&rdquo; bookings came straight through this campaign&apos;s booking links
            (deterministic). &ldquo;Via click-window&rdquo; is the fallback: the guest clicked this
            campaign within 7 days before booking.
            {attribution.cancelled > 0
              ? ` ${attribution.cancelled} attributed ${attribution.cancelled === 1 ? "booking was" : "bookings were"} cancelled and excluded.`
              : ""}
          </p>
        </div>
      ) : (
        <div className="rounded-card border-coral/30 bg-coral/5 border p-4">
          <p className="text-charcoal text-sm">
            <span className="text-ink font-semibold">See which emails fill tables.</span> Plus
            connects this campaign to the bookings, covers and deposits it generated.
          </p>
          <Link
            href="/dashboard/upgrade?feature=campaigns"
            className="bg-ink mt-3 inline-block rounded-md px-4 py-2 text-sm font-semibold text-white"
          >
            Upgrade to Plus
          </Link>
        </div>
      )}

      {/* Top links (Core+ engagement detail) */}
      {isEmail && topLinks.length > 0 ? (
        <div>
          <h2 className="text-ink mb-3 text-base font-semibold">Most-clicked links</h2>
          <div className="border-hairline rounded-card overflow-hidden border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-cloud text-ash text-left text-xs font-semibold tracking-wider uppercase">
                <tr>
                  <th className="px-4 py-2.5">Link</th>
                  <th className="px-4 py-2.5 text-right whitespace-nowrap">Unique clickers</th>
                </tr>
              </thead>
              <tbody className="divide-hairline divide-y">
                {topLinks.map((l) => (
                  <tr key={l.url}>
                    <td className="text-charcoal max-w-0 px-4 py-3">
                      <span className="block truncate" title={l.url}>
                        {l.url}
                      </span>
                    </td>
                    <td className="text-ink px-4 py-3 text-right font-medium">{l.clickers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-ash mt-2 text-xs">
            Counts unique guests per link (a guest clicking the same link twice counts once).
          </p>
        </div>
      ) : null}

      {/* Failures */}
      {failures.length > 0 ? (
        <div>
          <h2 className="text-ink mb-3 text-base font-semibold">Recent failures</h2>
          <div className="border-hairline rounded-card overflow-hidden border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-cloud text-ash text-left text-xs font-semibold tracking-wider uppercase">
                <tr>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Error</th>
                </tr>
              </thead>
              <tbody className="divide-hairline divide-y">
                {failures.map((f) => (
                  <tr key={f.id}>
                    <td className="text-charcoal px-4 py-3">{f.status}</td>
                    <td className="text-charcoal px-4 py-3 font-mono text-xs">{f.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
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
