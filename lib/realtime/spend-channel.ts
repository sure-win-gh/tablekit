// Realtime spend channel — subscribe the dashboard to guest_spend_summary
// changes for one org. RLS on guest_spend_summary (migration 0049) gates the
// stream, so a client only ever receives its own org's rows even though the
// filter below is belt-and-braces.
//
// Pure with respect to the Supabase client: it's passed in, so the channel
// wiring (filter string, table) is unit-testable without a live socket.

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

export type SpendSummaryRow = {
  guest_id: string;
  organisation_id: string;
  order_count: number;
  total_spend_minor: number;
  avg_spend_minor: number;
  last_order_at: string | null;
};

export type SpendChange = {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  row: Partial<SpendSummaryRow>;
};

// Subscribe to spend changes for an org. Returns an unsubscribe function.
export function subscribeToSpend(params: {
  supabase: SupabaseClient;
  organisationId: string;
  onChange: (change: SpendChange) => void;
}): () => void {
  const { supabase, organisationId, onChange } = params;

  const channel: RealtimeChannel = supabase
    .channel(`spend:${organisationId}`)
    .on(
      // postgres_changes — the realtime extension streams row changes that
      // pass RLS for the subscribed JWT.
      "postgres_changes" as never,
      {
        event: "*",
        schema: "public",
        table: "guest_spend_summary",
        filter: `organisation_id=eq.${organisationId}`,
      },
      (payload: {
        eventType: SpendChange["eventType"];
        new: SpendSummaryRow;
        old: SpendSummaryRow;
      }) => {
        const row = payload.eventType === "DELETE" ? payload.old : payload.new;
        onChange({ eventType: payload.eventType, row: row ?? {} });
      },
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
