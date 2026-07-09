"use client";

import { Lock } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { MARKETING_EMAIL } from "@/lib/billing/marketing-email";

import { CampaignComposer, type AudienceEstimate, type SegmentOption } from "./campaign-composer";

// One tab per broadcast channel. The active tab drives the composer's
// channel and filters the recent-campaigns list, so each channel reads as
// its own space. Email is Core+ with a monthly allowance + overage
// (docs/specs/email-broadcast-billing.md); SMS/WhatsApp broadcasts are
// Plus and spend prepaid credit — for Core the tabs render locked with an
// upgrade prompt (visible upsell, gated server-side too).

const CHANNELS = ["email", "sms", "whatsapp"] as const;
type Channel = (typeof CHANNELS)[number];

const CHANNEL_LABEL: Record<Channel, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

export type RecentCampaign = {
  id: string;
  name: string;
  channel: string;
  status: string;
  sent: number;
  opened: number;
};

function formatRate(pencePer1000: number): string {
  return `£${(pencePer1000 / 100).toFixed(2)} per 1,000`;
}

export function ChannelTabs({
  venueId,
  brandColour,
  plan,
  segments,
  canSegment,
  plusUnlocked,
  initialEstimate,
  initialBalancePence,
  mergeTags,
  channelCostPence,
  emailAllowanceRemaining,
  recent,
}: {
  venueId: string;
  brandColour: string | null;
  plan: "free" | "core" | "plus";
  segments: SegmentOption[];
  canSegment: boolean;
  plusUnlocked: boolean;
  initialEstimate: AudienceEstimate;
  initialBalancePence: number;
  mergeTags: string[];
  channelCostPence: Record<string, number>;
  emailAllowanceRemaining: number;
  recent: RecentCampaign[];
}) {
  const [channel, setChannel] = useState<Channel>("email");
  const list = recent.filter((c) => c.channel === channel);
  const locked = channel !== "email" && !plusUnlocked;

  const emailAllowance = MARKETING_EMAIL.allowancePerMonth[plan];
  const emailRate = MARKETING_EMAIL.overagePencePer1000[plan];

  const hint = (c: Channel): string => {
    if (c === "email") return `${emailAllowance.toLocaleString("en-GB")}/mo incl.`;
    if (!plusUnlocked) return "Plus";
    const pence = channelCostPence[c] ?? 0;
    return pence === 0 ? "free" : `${pence}p/msg`;
  };

  const blurb: Record<Channel, string> = {
    email: `Your plan includes ${emailAllowance.toLocaleString("en-GB")} marketing emails a month (${emailAllowanceRemaining.toLocaleString("en-GB")} left this month), then ${formatRate(emailRate)} + VAT from your messaging credit. An unsubscribe link is added automatically.`,
    sms: "SMS broadcasts are billed at cost from your prepaid messaging credit. A STOP line is added automatically.",
    whatsapp:
      "WhatsApp broadcasts are billed at cost from your prepaid messaging credit. A STOP line is added automatically.",
  };

  return (
    <div className="flex flex-col gap-6">
      <div
        role="tablist"
        aria-label="Broadcast channel"
        className="border-hairline bg-cloud flex w-fit gap-1 rounded-lg border p-1"
      >
        {CHANNELS.map((c) => {
          const active = c === channel;
          const isLockedTab = c !== "email" && !plusUnlocked;
          return (
            <button
              key={c}
              role="tab"
              aria-selected={active}
              onClick={() => setChannel(c)}
              className={
                active
                  ? "text-ink flex items-center rounded-md bg-white px-4 py-1.5 text-sm font-semibold shadow-sm"
                  : "text-ash hover:text-charcoal flex items-center rounded-md px-4 py-1.5 text-sm font-medium"
              }
            >
              {isLockedTab ? <Lock className="text-coral mr-1.5 h-3 w-3" aria-hidden /> : null}
              {CHANNEL_LABEL[c]}
              <span className={`ml-1.5 text-xs font-normal ${active ? "text-ash" : ""}`}>
                {hint(c)}
              </span>
            </button>
          );
        })}
      </div>

      {locked ? (
        <div className="rounded-card border-coral/30 bg-coral/5 flex max-w-2xl flex-col items-start gap-3 border p-6">
          <div className="flex items-center gap-2">
            <Lock className="text-coral h-4 w-4 shrink-0" aria-hidden />
            <h2 className="text-ink text-base font-semibold">
              {CHANNEL_LABEL[channel]} broadcasts are a Plus feature
            </h2>
          </div>
          <p className="text-charcoal text-sm">
            Reach guests where they actually look — {CHANNEL_LABEL[channel]} campaigns are billed at
            cost with no per-message markup. Plus also unlocks audience segments (New, Regular,
            Lapsed, VIP) and multi-venue tools.
          </p>
          <Link
            href="/dashboard/upgrade?feature=campaigns"
            className="bg-ink rounded-md px-4 py-2 text-sm font-semibold text-white"
          >
            Upgrade to Plus
          </Link>
        </div>
      ) : (
        <>
          <p className="text-ash text-sm">{blurb[channel]}</p>

          <CampaignComposer
            venueId={venueId}
            brandColour={brandColour}
            channel={channel}
            channelLabel={CHANNEL_LABEL[channel]}
            segments={segments}
            canSegment={canSegment}
            initialEstimate={initialEstimate}
            initialBalancePence={initialBalancePence}
            mergeTags={mergeTags}
          />
        </>
      )}

      <div>
        <h2 className="text-ink mb-3 text-base font-semibold">
          Recent {CHANNEL_LABEL[channel]} campaigns
        </h2>
        {list.length === 0 ? (
          <p className="text-ash text-sm">No {CHANNEL_LABEL[channel]} campaigns yet.</p>
        ) : (
          <div className="border-hairline rounded-card overflow-hidden border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-cloud text-ash text-left text-xs font-semibold tracking-wider uppercase">
                <tr>
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Sent</th>
                  <th className="px-4 py-2.5">Opened</th>
                </tr>
              </thead>
              <tbody className="divide-hairline divide-y">
                {list.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/venues/${venueId}/campaigns/${c.id}`}
                        className="text-ink hover:text-coral font-medium underline-offset-2 hover:underline"
                      >
                        {c.name}
                      </Link>
                    </td>
                    <td className="text-charcoal px-4 py-3">{c.status}</td>
                    <td className="text-charcoal px-4 py-3">{c.sent}</td>
                    <td className="text-charcoal px-4 py-3">{c.opened}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
