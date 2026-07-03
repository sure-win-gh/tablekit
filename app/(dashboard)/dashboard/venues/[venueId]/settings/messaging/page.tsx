import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { UpgradeBanner } from "@/components/billing/locked-feature";
import { cn } from "@/components/ui";
import { isLocked } from "@/lib/auth/entitlements";
import { hasPlan } from "@/lib/auth/plan-level";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { billingPeriod } from "@/lib/billing/usage";
import { withUser } from "@/lib/db/client";
import { messageTemplates, messageUsage, venues } from "@/lib/db/schema";
import { MERGE_TAG_NAMES } from "@/lib/messaging/merge-tags";
import { templateChannels } from "@/lib/messaging/registry";
import {
  FLOW_EVENTS,
  FLOW_EVENT_TEMPLATE,
  parseBranding,
  parseMessagingSettings,
  type FlowEvent,
} from "@/lib/messaging/venue-settings";

import { BrandingTab } from "./branding-tab";
import { MessagesTab, type CopyOverride, type MessageRowView } from "./messages-tab";

export const metadata = { title: "Messaging · TableKit" };

const EVENT_META: Record<
  FlowEvent,
  { label: string; help: string; timing: "before" | "after" | null }
> = {
  confirmation: {
    label: "Booking confirmation",
    help: "Sent as soon as a booking is confirmed.",
    timing: null,
  },
  reminder_24h: {
    label: "24-hour reminder",
    help: "A reminder the day before the booking.",
    timing: "before",
  },
  reminder_2h: {
    label: "2-hour reminder",
    help: "A nudge a couple of hours before arrival.",
    timing: "before",
  },
  cancelled: {
    label: "Cancellation",
    help: "Sent when a booking is cancelled.",
    timing: null,
  },
  thank_you: {
    label: "Thank-you",
    help: "Sent a few hours after the visit finishes.",
    timing: "after",
  },
};

const TABS = [
  { key: "messages", label: "Messages" },
  { key: "branding", label: "Branding" },
  { key: "usage", label: "Usage & costs" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default async function MessagingSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { orgId } = await requireRole("manager");
  const orgPlan = await getPlan(orgId);
  const { venueId } = await params;
  const { tab: tabParam } = await searchParams;
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : "messages";

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id, settings: venues.settings })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();

  const messaging = parseMessagingSettings(venue.settings);
  const branding = parseBranding(venue.settings);

  const overrideRows = await withUser(async (db) =>
    db
      .select({
        template: messageTemplates.template,
        channel: messageTemplates.channel,
        subjectOverride: messageTemplates.subjectOverride,
        bodyOverride: messageTemplates.bodyOverride,
        enabled: messageTemplates.enabled,
      })
      .from(messageTemplates)
      .where(eq(messageTemplates.venueId, venueId)),
  );

  const rows: MessageRowView[] = FLOW_EVENTS.map((ev) => {
    const cfg = messaging[ev];
    const meta = EVENT_META[ev];
    const template = FLOW_EVENT_TEMPLATE[ev];
    const overrides: Record<string, CopyOverride> = {};
    for (const o of overrideRows) {
      if (o.template === template) {
        overrides[o.channel] = {
          subjectOverride: o.subjectOverride,
          bodyOverride: o.bodyOverride,
          enabled: o.enabled,
        };
      }
    }
    return {
      event: ev,
      template,
      label: meta.label,
      help: meta.help,
      capableChannels: templateChannels(template),
      timing: meta.timing,
      enabled: cfg.enabled,
      primary: cfg.channels[0] ?? "email",
      secondary: cfg.channels[1] ?? null,
      hours: cfg.hoursBeforeStart ?? cfg.hoursAfterFinish ?? null,
      overrides,
    };
  });

  // Usage tab data — this billing month, this org, straight off the
  // metered-usage ledger (RLS grants members SELECT on their own org).
  const period = billingPeriod(new Date());
  const usage =
    tab === "usage"
      ? await withUser(async (db) =>
          db
            .select({
              channel: messageUsage.channel,
              count: messageUsage.count,
              costPence: messageUsage.estCostPence,
            })
            .from(messageUsage)
            .where(and(eq(messageUsage.organisationId, orgId), eq(messageUsage.period, period)))
            .orderBy(messageUsage.channel),
        )
      : [];

  const base = `/dashboard/venues/${venueId}/settings/messaging`;

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-ink text-xl font-bold tracking-tight">Messaging</h2>
        <p className="text-ash mt-0.5 text-sm">
          Choose which messages go out, on which channels, and customise their content.
        </p>
      </div>

      <div className="border-hairline rounded-card border bg-white p-6">
        {isLocked(orgPlan, "messaging") ? <UpgradeBanner feature="messaging" /> : null}

        <nav
          className="border-hairline mb-5 flex items-center gap-1 border-b"
          aria-label="Messaging sections"
        >
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={t.key === "messages" ? base : `${base}?tab=${t.key}`}
              aria-current={tab === t.key ? "page" : undefined}
              className={cn(
                "-mb-px px-4 py-2 text-sm font-semibold transition",
                tab === t.key
                  ? "border-ink text-ink border-b-2"
                  : "text-ash hover:text-ink border-b-2 border-transparent",
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        {tab === "messages" ? (
          <MessagesTab venueId={venue.id} rows={rows} mergeTags={[...MERGE_TAG_NAMES]} />
        ) : null}

        {tab === "branding" ? (
          <BrandingTab
            venueId={venue.id}
            isPlus={hasPlan(orgPlan, "plus")}
            branding={{
              logoUrl: branding?.logoUrl ?? "",
              brandColour: branding?.brandColour ?? "",
              signature: branding?.signature ?? "",
              replyTo: branding?.replyTo ?? "",
              cornerStyle: branding?.cornerStyle ?? "",
            }}
          />
        ) : null}

        {tab === "usage" ? <UsageTab usage={usage} period={period} /> : null}
      </div>
    </section>
  );
}

function UsageTab({
  usage,
  period,
}: {
  usage: { channel: string; count: number; costPence: number }[];
  period: string;
}) {
  const totalSends = usage.reduce((s, r) => s + r.count, 0);
  const totalPence = usage.reduce((s, r) => s + r.costPence, 0);
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <p className="text-ash text-xs">
        Metered sends across your organisation for the current billing month ({period}). SMS and
        WhatsApp are pass-through at cost — TableKit adds no margin. Email is always free and
        isn&apos;t metered.
      </p>
      {usage.length === 0 ? (
        <p className="text-ash text-xs">No metered sends this month.</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-ash text-left">
            <tr>
              <th className="py-1 font-medium">Channel</th>
              <th className="py-1 text-right font-medium">Sends</th>
              <th className="py-1 text-right font-medium">Est. cost</th>
            </tr>
          </thead>
          <tbody className="divide-hairline divide-y">
            {usage.map((row) => (
              <tr key={row.channel}>
                <td className="text-ink py-1.5">{row.channel}</td>
                <td className="text-ink py-1.5 text-right tabular-nums">{row.count}</td>
                <td className="text-ink py-1.5 text-right tabular-nums">
                  £{(row.costPence / 100).toFixed(2)}
                </td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="text-ink py-1.5">Total</td>
              <td className="text-ink py-1.5 text-right tabular-nums">{totalSends}</td>
              <td className="text-ink py-1.5 text-right tabular-nums">
                £{(totalPence / 100).toFixed(2)}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
