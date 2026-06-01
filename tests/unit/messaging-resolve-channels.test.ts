// Phase 2 — flow control. Verifies the channel resolver picks the first
// deliverable channel in the operator's preference order, intersected
// with registry capability + guest suppression, and that the settings
// parser reproduces the shipped defaults for an empty config.

import { describe, expect, it } from "vitest";

import { resolveChannel, type GuestChannelState } from "@/lib/messaging/resolve-channels";
import {
  parseMessagingSettings,
  MESSAGING_SETTINGS_DEFAULTS,
  type FlowEventSettings,
} from "@/lib/messaging/venue-settings";

const VENUE = "11111111-1111-1111-1111-111111111111";
const OTHER_VENUE = "22222222-2222-2222-2222-222222222222";

function guest(overrides: Partial<GuestChannelState> = {}): GuestChannelState {
  return {
    hasPhone: true,
    erasedAt: null,
    emailInvalid: false,
    phoneInvalid: false,
    whatsappInvalid: false,
    emailUnsubscribedVenues: [],
    smsUnsubscribedVenues: [],
    whatsappUnsubscribedVenues: [],
    ...overrides,
  };
}

function config(overrides: Partial<FlowEventSettings> = {}): FlowEventSettings {
  return { enabled: true, channels: ["email"], ...overrides };
}

describe("parseMessagingSettings", () => {
  it("returns shipped defaults for empty settings", () => {
    expect(parseMessagingSettings({})).toEqual(MESSAGING_SETTINGS_DEFAULTS);
    expect(parseMessagingSettings(null)).toEqual(MESSAGING_SETTINGS_DEFAULTS);
    expect(parseMessagingSettings({ messaging: {} })).toEqual(MESSAGING_SETTINGS_DEFAULTS);
  });

  it("falls back to the default on an out-of-bound timing", () => {
    const parsed = parseMessagingSettings({
      messaging: { reminder_24h: { enabled: true, channels: ["email"], hoursBeforeStart: 9999 } },
    });
    // 9999 is out of [1,168] → whole event falls back to default (24h).
    expect(parsed.reminder_24h.hoursBeforeStart).toBe(24);
  });

  it("accepts a valid custom channel order + timing", () => {
    const parsed = parseMessagingSettings({
      messaging: {
        reminder_2h: { enabled: true, channels: ["whatsapp", "sms"], hoursBeforeStart: 3 },
      },
    });
    expect(parsed.reminder_2h.channels).toEqual(["whatsapp", "sms"]);
    expect(parsed.reminder_2h.hoursBeforeStart).toBe(3);
  });
});

describe("resolveChannel", () => {
  it("returns null when the event is disabled", () => {
    expect(
      resolveChannel({
        event: "confirmation",
        venueId: VENUE,
        config: config({ enabled: false }),
        guest: guest(),
      }),
    ).toBeNull();
  });

  it("returns null for an erased guest", () => {
    expect(
      resolveChannel({
        event: "confirmation",
        venueId: VENUE,
        config: config(),
        guest: guest({ erasedAt: new Date(0) }),
      }),
    ).toBeNull();
  });

  it("picks the first deliverable channel in preference order", () => {
    // reminder_2h can render sms + whatsapp. Operator prefers whatsapp.
    expect(
      resolveChannel({
        event: "reminder_2h",
        venueId: VENUE,
        config: config({ channels: ["whatsapp", "sms"] }),
        guest: guest(),
      }),
    ).toBe("whatsapp");
  });

  it("falls through to the next channel when the preferred one is suppressed", () => {
    expect(
      resolveChannel({
        event: "reminder_2h",
        venueId: VENUE,
        config: config({ channels: ["whatsapp", "sms"] }),
        guest: guest({ whatsappUnsubscribedVenues: [VENUE] }),
      }),
    ).toBe("sms");
  });

  it("skips a channel the template cannot render", () => {
    // confirmation renders email + whatsapp, NOT sms. Operator lists sms first.
    expect(
      resolveChannel({
        event: "confirmation",
        venueId: VENUE,
        config: config({ channels: ["sms", "email"] }),
        guest: guest(),
      }),
    ).toBe("email");
  });

  it("requires a phone for whatsapp/sms", () => {
    expect(
      resolveChannel({
        event: "reminder_2h",
        venueId: VENUE,
        config: config({ channels: ["whatsapp", "sms"] }),
        guest: guest({ hasPhone: false }),
      }),
    ).toBeNull();
  });

  it("only suppresses for the matching venue", () => {
    expect(
      resolveChannel({
        event: "confirmation",
        venueId: VENUE,
        config: config({ channels: ["email"] }),
        guest: guest({ emailUnsubscribedVenues: [OTHER_VENUE] }),
      }),
    ).toBe("email");
  });

  it("returns null when every preferred channel is suppressed", () => {
    expect(
      resolveChannel({
        event: "confirmation",
        venueId: VENUE,
        config: config({ channels: ["email"] }),
        guest: guest({ emailUnsubscribedVenues: [VENUE] }),
      }),
    ).toBeNull();
  });
});
