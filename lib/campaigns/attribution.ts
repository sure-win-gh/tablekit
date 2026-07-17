// Click-window campaign attribution — the probabilistic fallback
// (marketing-suite Phase B).
//
// Link attribution (?tk_c=) is deterministic and stamped at booking
// creation. This nightly sweep catches the rest: a booking with no
// attribution whose guest CLICKED a campaign email for the SAME venue in
// the 7 days before booking gets attribution_kind='click_window'. The
// latest qualifying click wins; a stamped booking is never re-stamped, so
// link attribution always takes precedence and a booking never carries two
// attributions. Reported separately in the UI — never blended silently.
//
// Uses only data we already hold (campaign_sends.clicked_at + the
// booking's guest linkage) — no new tracking surface.

import "server-only";

import { sql } from "drizzle-orm";

import { adminDb } from "@/lib/server/admin/db";

export const CLICK_WINDOW_DAYS = 7;
// How far back the sweep re-examines bookings. > 1 day so a missed cron
// run self-heals; bounded so the nightly scan stays cheap.
export const SWEEP_LOOKBACK_DAYS = 3;

export type ClickWindowResult = { attributed: number };

export async function attributeClickWindowBookings(now: Date): Promise<ClickWindowResult> {
  const db = adminDb();
  const r = await db.execute(sql`
    update bookings b
    set campaign_id = pick.campaign_id,
        attribution_kind = 'click_window',
        updated_at = now()
    from (
      select distinct on (b2.id) b2.id as booking_id, cs.campaign_id
      from bookings b2
      join campaign_sends cs
        on cs.guest_id = b2.guest_id
       and cs.venue_id = b2.venue_id
       and cs.channel = 'email'
       and cs.clicked_at is not null
       and cs.clicked_at <= b2.created_at
       and cs.clicked_at >= b2.created_at - make_interval(days => ${CLICK_WINDOW_DAYS})
      where b2.campaign_id is null
        and b2.attribution_kind is null
        and b2.created_at >= ${now.toISOString()}::timestamptz - make_interval(days => ${SWEEP_LOOKBACK_DAYS})
      order by b2.id, cs.clicked_at desc
    ) pick
    where b.id = pick.booking_id
  `);
  return { attributed: r.rowCount ?? 0 };
}
