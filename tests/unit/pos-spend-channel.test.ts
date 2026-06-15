// Unit test for the Realtime spend-channel wiring. Verifies the channel
// targets guest_spend_summary filtered by organisation_id, and that the
// change callback maps INSERT/UPDATE to `new` and DELETE to `old`.

import { describe, expect, it, vi } from "vitest";

import { subscribeToSpend, type SpendChange } from "@/lib/realtime/spend-channel";

type Handler = (payload: unknown) => void;

function fakeSupabase() {
  const captured: { topic?: string; config?: Record<string, unknown>; handler?: Handler } = {};
  const channel = {
    on(_event: string, config: Record<string, unknown>, handler: Handler) {
      captured.config = config;
      captured.handler = handler;
      return channel;
    },
    subscribe() {
      return channel;
    },
  };
  const supabase = {
    channel(topic: string) {
      captured.topic = topic;
      return channel;
    },
    removeChannel: vi.fn(),
  };
  return { supabase, captured };
}

describe("subscribeToSpend", () => {
  it("subscribes to guest_spend_summary filtered by organisation_id", () => {
    const { supabase, captured } = fakeSupabase();
    subscribeToSpend({
      supabase: supabase as never,
      organisationId: "org-123",
      onChange: () => {},
    });
    expect(captured.topic).toBe("spend:org-123");
    expect(captured.config).toMatchObject({
      schema: "public",
      table: "guest_spend_summary",
      filter: "organisation_id=eq.org-123",
    });
  });

  it("maps UPDATE to the new row and DELETE to the old row", () => {
    const { supabase, captured } = fakeSupabase();
    const changes: SpendChange[] = [];
    subscribeToSpend({
      supabase: supabase as never,
      organisationId: "org-1",
      onChange: (c) => changes.push(c),
    });

    captured.handler?.({
      eventType: "UPDATE",
      new: { guest_id: "g1", total_spend_minor: 500 },
      old: {},
    });
    captured.handler?.({ eventType: "DELETE", new: {}, old: { guest_id: "g2" } });

    expect(changes[0]).toEqual({
      eventType: "UPDATE",
      row: { guest_id: "g1", total_spend_minor: 500 },
    });
    expect(changes[1]).toEqual({ eventType: "DELETE", row: { guest_id: "g2" } });
  });

  it("returns an unsubscribe that removes the channel", () => {
    const { supabase } = fakeSupabase();
    const unsub = subscribeToSpend({
      supabase: supabase as never,
      organisationId: "org-1",
      onChange: () => {},
    });
    unsub();
    expect(supabase.removeChannel).toHaveBeenCalledOnce();
  });
});
