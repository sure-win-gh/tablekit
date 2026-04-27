// Transactional message volume + delivery health, last 7d.
//
// Grouped by (channel, status) so the overview can show a single
// matrix: email sent vs bounced, sms delivered vs failed, etc.
// Values for messages.status today: queued / sending / sent / delivered
// / bounced / failed (per messaging.md). We pass them through verbatim
// rather than collapsing into "ok / not ok" — the founder will want to
// see a spike in `bounced` separately from a spike in `failed`.

import "server-only";

import { and, gte, lte, sql } from "drizzle-orm";

import { messages } from "@/lib/db/schema";

import { lastNDays } from "../filter";
import type { AdminDb } from "../types";

export type MessageVolumeRow = {
  channel: string;
  status: string;
  count: number;
};

export async function getMessageVolume7d(
  db: AdminDb,
  now: Date = new Date(),
): Promise<MessageVolumeRow[]> {
  const bounds = lastNDays(7, now);
  return db
    .select({
      channel: messages.channel,
      status: messages.status,
      count: sql<number>`count(*)::int`.as("count"),
    })
    .from(messages)
    .where(and(gte(messages.createdAt, bounds.fromUtc), lte(messages.createdAt, bounds.toUtc)))
    .groupBy(messages.channel, messages.status)
    .orderBy(messages.channel, messages.status);
}
