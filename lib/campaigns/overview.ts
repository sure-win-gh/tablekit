// Marketing overview — trailing-window roll-up across all of a venue's
// campaigns (docs/specs/marketing-suite.md, Part 2 "Marketing overview
// page"). Three lenses:
//
//   1. Channel roll-up      — sends/delivered/opens/clicks/bookings/covers
//                             per channel, for campaigns SENT in the window.
//   2. Top campaigns        — ranked by booking conversion (bookings /
//                             delivered), the headline Plus metric.
//   3. Audience health      — per-channel consented list size, new opt-ins
//                             in the window, and current unsubscribe share.
//
// Every metric is anchored on the campaign's `sent_at`: a campaign is
// either in-window or not, and all of its sends/opens/clicks/bookings roll
// up together. Attribution mirrors the per-campaign report — cancelled
// bookings are excluded, opens carry the Apple-MPP caveat at the UI layer.
//
// All queries take a `Db` and are called inside `withUser`, so RLS
// org-scopes them; the explicit venue filter narrows within the org.

import "server-only";

import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { bookings, campaignSends, campaigns, guests } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";
import type { MessageChannel } from "@/lib/messaging/registry";

type Db = NodePgDatabase<typeof schema>;

export const OVERVIEW_WINDOW_DAYS = 90;

export const MARKETING_CHANNELS: readonly MessageChannel[] = ["email", "sms", "whatsapp"];

export const CHANNEL_LABEL: Record<MessageChannel, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

export function windowStart(now: Date, days = OVERVIEW_WINDOW_DAYS): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export type ChannelRollupRow = {
  channel: MessageChannel;
  campaigns: number;
  sends: number;
  delivered: number;
  opened: number;
  clicked: number;
  bookings: number;
  covers: number;
};

// Sends/delivery/engagement per channel, plus attributed bookings/covers,
// for campaigns sent in [since, now). Two grouped queries (send rows and
// booking rows have no shared grain) merged in JS by channel.
export async function getChannelRollup(
  db: Db,
  venueId: string,
  since: Date,
): Promise<ChannelRollupRow[]> {
  const sendRows = await db
    .select({
      channel: campaigns.channel,
      campaigns: sql<number>`count(distinct ${campaigns.id})::int`,
      sends: sql<number>`count(*) filter (where ${campaignSends.sentAt} is not null)::int`,
      delivered: sql<number>`count(*) filter (where ${campaignSends.status} = 'delivered')::int`,
      opened: sql<number>`count(*) filter (where ${campaignSends.openedAt} is not null)::int`,
      clicked: sql<number>`count(*) filter (where ${campaignSends.clickedAt} is not null)::int`,
    })
    .from(campaignSends)
    .innerJoin(campaigns, eq(campaigns.id, campaignSends.campaignId))
    .where(
      and(
        eq(campaigns.venueId, venueId),
        isNotNull(campaigns.sentAt),
        gte(campaigns.sentAt, since),
      ),
    )
    .groupBy(campaigns.channel);

  const bookingRows = await db
    .select({
      channel: campaigns.channel,
      bookings: sql<number>`count(*) filter (where ${bookings.status} <> 'cancelled')::int`,
      covers: sql<number>`coalesce(sum(${bookings.partySize}) filter (where ${bookings.status} <> 'cancelled'), 0)::int`,
    })
    .from(bookings)
    .innerJoin(campaigns, eq(campaigns.id, bookings.campaignId))
    .where(
      and(
        eq(campaigns.venueId, venueId),
        isNotNull(campaigns.sentAt),
        gte(campaigns.sentAt, since),
      ),
    )
    .groupBy(campaigns.channel);

  const byChannel = new Map<string, ChannelRollupRow>();
  for (const r of sendRows) {
    byChannel.set(r.channel, {
      channel: r.channel as MessageChannel,
      campaigns: r.campaigns,
      sends: r.sends,
      delivered: r.delivered,
      opened: r.opened,
      clicked: r.clicked,
      bookings: 0,
      covers: 0,
    });
  }
  for (const r of bookingRows) {
    const existing = byChannel.get(r.channel);
    if (existing) {
      existing.bookings = r.bookings;
      existing.covers = r.covers;
    } else {
      // Bookings attributed to a campaign with no send rows in the
      // window — unlikely, but don't drop the covers silently.
      byChannel.set(r.channel, {
        channel: r.channel as MessageChannel,
        campaigns: 0,
        sends: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        bookings: r.bookings,
        covers: r.covers,
      });
    }
  }

  // Stable channel order for the UI + CSV.
  return MARKETING_CHANNELS.map((c) => byChannel.get(c)).filter(
    (r): r is ChannelRollupRow => r !== undefined,
  );
}

export type TopCampaignRow = {
  id: string;
  name: string;
  channel: MessageChannel;
  sentAt: Date | null;
  delivered: number;
  clicked: number;
  bookings: number;
  covers: number;
  // bookings / delivered — the "did this email fill tables" number.
  conversion: number;
};

// Campaigns sent in the window ranked by booking conversion. A campaign
// with no delivered sends yet has conversion 0 (not NaN) and sorts last.
export async function getTopCampaigns(
  db: Db,
  venueId: string,
  since: Date,
  limit = 10,
): Promise<TopCampaignRow[]> {
  const sendAgg = await db
    .select({
      campaignId: campaignSends.campaignId,
      delivered: sql<number>`count(*) filter (where ${campaignSends.status} = 'delivered')::int`,
      sent: sql<number>`count(*) filter (where ${campaignSends.sentAt} is not null)::int`,
      clicked: sql<number>`count(*) filter (where ${campaignSends.clickedAt} is not null)::int`,
    })
    .from(campaignSends)
    .innerJoin(campaigns, eq(campaigns.id, campaignSends.campaignId))
    .where(
      and(
        eq(campaigns.venueId, venueId),
        isNotNull(campaigns.sentAt),
        gte(campaigns.sentAt, since),
      ),
    )
    .groupBy(campaignSends.campaignId);

  const bookingAgg = await db
    .select({
      campaignId: bookings.campaignId,
      bookings: sql<number>`count(*) filter (where ${bookings.status} <> 'cancelled')::int`,
      covers: sql<number>`coalesce(sum(${bookings.partySize}) filter (where ${bookings.status} <> 'cancelled'), 0)::int`,
    })
    .from(bookings)
    .innerJoin(campaigns, eq(campaigns.id, bookings.campaignId))
    .where(
      and(
        eq(campaigns.venueId, venueId),
        isNotNull(campaigns.sentAt),
        gte(campaigns.sentAt, since),
      ),
    )
    .groupBy(bookings.campaignId);

  const meta = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      channel: campaigns.channel,
      sentAt: campaigns.sentAt,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.venueId, venueId),
        isNotNull(campaigns.sentAt),
        gte(campaigns.sentAt, since),
      ),
    );

  const sends = new Map(sendAgg.map((r) => [r.campaignId, r]));
  const books = new Map(bookingAgg.map((r) => [r.campaignId, r]));

  const rows: TopCampaignRow[] = meta.map((c) => {
    const s = sends.get(c.id);
    const b = books.get(c.id);
    const delivered = s?.delivered ?? 0;
    // Providers without delivery receipts leave status at 'sent'.
    const base = Math.max(delivered, s?.sent ?? 0);
    const bookingCount = b?.bookings ?? 0;
    return {
      id: c.id,
      name: c.name,
      channel: c.channel as MessageChannel,
      sentAt: c.sentAt,
      delivered,
      clicked: s?.clicked ?? 0,
      bookings: bookingCount,
      covers: b?.covers ?? 0,
      conversion: base === 0 ? 0 : bookingCount / base,
    };
  });

  rows.sort((a, b) => b.conversion - a.conversion || b.bookings - a.bookings);
  return rows.slice(0, limit);
}

export type ChannelAudienceHealth = {
  channel: MessageChannel;
  // Guests currently reachable on this channel for this venue (consent
  // set, not invalid, not unsubscribed here, not erased).
  consented: number;
  // Gross opt-ins whose consent timestamp falls inside the window.
  newOptIns: number;
  // Guests who have unsubscribed from THIS venue on this channel.
  unsubscribed: number;
  // unsubscribed / (consented + unsubscribed) — the share of the
  // once-opted-in list that has since opted out. A current snapshot, not
  // a windowed rate (we don't timestamp opt-outs).
  unsubRate: number;
};

// One pass over guests, computing per-channel consent/opt-in/opt-out
// counts with conditional aggregates. Org scoping is via RLS; erased
// guests are excluded everywhere.
export async function getAudienceHealth(
  db: Db,
  venueId: string,
  since: Date,
): Promise<ChannelAudienceHealth[]> {
  const v = sql`${venueId}::uuid`;
  const [row] = await db
    .select({
      emailConsented: sql<number>`count(*) filter (where ${guests.marketingConsentEmailAt} is not null and ${guests.emailInvalid} = false and not (${v} = any(${guests.emailUnsubscribedVenues})))::int`,
      emailNew: sql<number>`count(*) filter (where ${guests.marketingConsentEmailAt} >= ${since})::int`,
      emailUnsub: sql<number>`count(*) filter (where ${v} = any(${guests.emailUnsubscribedVenues}))::int`,
      smsConsented: sql<number>`count(*) filter (where ${guests.marketingConsentSmsAt} is not null and ${guests.phoneInvalid} = false and ${guests.phoneCipher} is not null and not (${v} = any(${guests.smsUnsubscribedVenues})))::int`,
      smsNew: sql<number>`count(*) filter (where ${guests.marketingConsentSmsAt} >= ${since})::int`,
      smsUnsub: sql<number>`count(*) filter (where ${v} = any(${guests.smsUnsubscribedVenues}))::int`,
      whatsappConsented: sql<number>`count(*) filter (where ${guests.marketingConsentWhatsappAt} is not null and ${guests.whatsappInvalid} = false and ${guests.phoneCipher} is not null and not (${v} = any(${guests.whatsappUnsubscribedVenues})))::int`,
      whatsappNew: sql<number>`count(*) filter (where ${guests.marketingConsentWhatsappAt} >= ${since})::int`,
      whatsappUnsub: sql<number>`count(*) filter (where ${v} = any(${guests.whatsappUnsubscribedVenues}))::int`,
    })
    .from(guests)
    .where(sql`${guests.erasedAt} is null`);

  const r = row ?? {
    emailConsented: 0,
    emailNew: 0,
    emailUnsub: 0,
    smsConsented: 0,
    smsNew: 0,
    smsUnsub: 0,
    whatsappConsented: 0,
    whatsappNew: 0,
    whatsappUnsub: 0,
  };

  const build = (
    channel: MessageChannel,
    consented: number,
    newOptIns: number,
    unsubscribed: number,
  ): ChannelAudienceHealth => {
    const denom = consented + unsubscribed;
    return {
      channel,
      consented,
      newOptIns,
      unsubscribed,
      unsubRate: denom === 0 ? 0 : unsubscribed / denom,
    };
  };

  return [
    build("email", r.emailConsented, r.emailNew, r.emailUnsub),
    build("sms", r.smsConsented, r.smsNew, r.smsUnsub),
    build("whatsapp", r.whatsappConsented, r.whatsappNew, r.whatsappUnsub),
  ];
}

export type MarketingOverview = {
  since: Date;
  channels: ChannelRollupRow[];
  topCampaigns: TopCampaignRow[];
  audience: ChannelAudienceHealth[];
};

export async function getMarketingOverview(
  db: Db,
  venueId: string,
  now: Date,
): Promise<MarketingOverview> {
  const since = windowStart(now);
  const [channels, topCampaigns, audience] = await Promise.all([
    getChannelRollup(db, venueId, since),
    getTopCampaigns(db, venueId, since),
    getAudienceHealth(db, venueId, since),
  ]);
  return { since, channels, topCampaigns, audience };
}
