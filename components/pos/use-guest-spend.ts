// useGuestSpend — live per-guest spend for the dashboard spend panels.
//
// Seeds from a server-rendered initial value, then subscribes to Realtime
// changes on guest_spend_summary (RLS-gated to the caller's org) so the
// panel updates within seconds of a webhook. A 30s poll is kept as a
// fallback for clients that can't hold a socket (mirrors the floor-plan
// auto-refresh posture). Consumed by the guest-profile / floor-plan /
// booking-detail spend panels.

"use client";

import { useEffect, useState } from "react";

import { subscribeToSpend, type SpendSummaryRow } from "@/lib/realtime/spend-channel";
import { createBrowserSupabase } from "@/lib/supabase/browser";

export type GuestSpend = {
  orderCount: number;
  totalSpendMinor: number;
  avgSpendMinor: number;
  lastOrderAt: string | null;
} | null;

function mapRow(row: Partial<SpendSummaryRow>): GuestSpend {
  if (row.order_count == null) return null;
  return {
    orderCount: Number(row.order_count),
    totalSpendMinor: Number(row.total_spend_minor ?? 0),
    avgSpendMinor: Number(row.avg_spend_minor ?? 0),
    lastOrderAt: row.last_order_at ?? null,
  };
}

export function useGuestSpend(params: {
  guestId: string;
  organisationId: string;
  initial: GuestSpend;
}): GuestSpend {
  const { guestId, organisationId, initial } = params;
  const [spend, setSpend] = useState<GuestSpend>(initial);

  useEffect(() => {
    const supabase = createBrowserSupabase();

    const unsubscribe = subscribeToSpend({
      supabase,
      organisationId,
      onChange: (change) => {
        if (change.row.guest_id !== guestId) return;
        setSpend(change.eventType === "DELETE" ? null : mapRow(change.row));
      },
    });

    // Poll fallback — RLS on the table means this only ever returns our
    // own org's row.
    const poll = setInterval(() => {
      void supabase
        .from("guest_spend_summary")
        .select(
          "guest_id, organisation_id, order_count, total_spend_minor, avg_spend_minor, last_order_at",
        )
        .eq("guest_id", guestId)
        .maybeSingle()
        .then(({ data }: { data: SpendSummaryRow | null }) => {
          setSpend(data ? mapRow(data) : null);
        });
    }, 30_000);

    return () => {
      unsubscribe();
      clearInterval(poll);
    };
  }, [guestId, organisationId]);

  return spend;
}
