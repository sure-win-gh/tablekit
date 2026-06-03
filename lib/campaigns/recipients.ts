// Resolve a campaign's audience: consented, reachable, non-suppressed,
// non-erased guests in the org for the chosen channel.
//
// This is the Art. 6(1)(a) gate — marketing only goes to guests who
// opted IN to this channel (a per-channel consent timestamp) and who
// have not opted out of this venue, hard-bounced, or been erased. The
// dispatch worker re-checks the same predicate per send (the consent
// state can change between enqueue and send).
//
// v1 audience = all org guests with channel consent (minus per-venue
// opt-out / invalid / erased / no-contact). Segment narrowing (lapsed,
// VIP, visited-since) lands in Phase 4.

import "server-only";

import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import { guests } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import { segmentPredicate, type Segment } from "@/lib/guests/segments";
import type { MessageChannel } from "@/lib/messaging/registry";
import { estimateCostPence } from "@/lib/billing/usage";

// Optional segment narrowing. `now` anchors time-relative segments
// (lapsed); defaults applied by callers. `all` adds no predicate, so a
// segment-less campaign behaves exactly as Phase 3.
export type AudienceOpts = { segment?: Segment; now?: Date };

// Build the per-channel consent + reachability predicate shared by the
// recipient query and the dispatch-time re-check. Segment (if any) is
// and-composed INSIDE the consent gate — it can only narrow, never widen.
export function audiencePredicate(
  organisationId: string,
  venueId: string,
  channel: MessageChannel,
  opts: AudienceOpts = {},
): SQL {
  const base = [eq(guests.organisationId, organisationId), isNull(guests.erasedAt)];

  if (channel === "email") {
    base.push(
      isNotNull(guests.marketingConsentEmailAt),
      eq(guests.emailInvalid, false),
      sql`NOT (${venueId}::uuid = ANY(${guests.emailUnsubscribedVenues}))`,
    );
  } else if (channel === "sms") {
    base.push(
      isNotNull(guests.marketingConsentSmsAt),
      eq(guests.phoneInvalid, false),
      isNotNull(guests.phoneCipher),
      sql`NOT (${venueId}::uuid = ANY(${guests.smsUnsubscribedVenues}))`,
    );
  } else {
    base.push(
      isNotNull(guests.marketingConsentWhatsappAt),
      eq(guests.whatsappInvalid, false),
      isNotNull(guests.phoneCipher),
      sql`NOT (${venueId}::uuid = ANY(${guests.whatsappUnsubscribedVenues}))`,
    );
  }

  const seg =
    opts.segment && opts.segment !== "all"
      ? segmentPredicate(venueId, opts.segment, opts.now ?? new Date())
      : undefined;
  if (seg) base.push(seg);

  return and(...base)!;
}

export async function resolveRecipientIds(
  organisationId: string,
  venueId: string,
  channel: MessageChannel,
  opts: AudienceOpts = {},
): Promise<string[]> {
  const rows = await adminDb()
    .select({ id: guests.id })
    .from(guests)
    .where(audiencePredicate(organisationId, venueId, channel, opts));
  return rows.map((r) => r.id);
}

export type AudienceEstimate = { count: number; costPence: number };

export async function estimateAudience(
  organisationId: string,
  venueId: string,
  channel: MessageChannel,
  opts: AudienceOpts = {},
): Promise<AudienceEstimate> {
  const [row] = await adminDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(guests)
    .where(audiencePredicate(organisationId, venueId, channel, opts));
  const count = row?.count ?? 0;
  return { count, costPence: estimateCostPence(channel, count) };
}

// Dispatch-time re-check for a single guest — true if still in the
// audience. The per-channel + segment predicate matches enqueue, so a
// guest who left the segment (e.g. a lapsed guest who re-booked) is
// dropped before a scheduled send.
export async function isStillEligible(
  organisationId: string,
  venueId: string,
  channel: MessageChannel,
  guestId: string,
  opts: AudienceOpts = {},
): Promise<boolean> {
  const [row] = await adminDb()
    .select({ id: guests.id })
    .from(guests)
    .where(and(eq(guests.id, guestId), audiencePredicate(organisationId, venueId, channel, opts)))
    .limit(1);
  return Boolean(row);
}
