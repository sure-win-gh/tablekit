// mergeMessagingEvent — the per-message save's load-bearing invariant:
// saving one event must never clobber sibling events, branding, or any
// unrelated root settings key.

import { describe, expect, it } from "vitest";

import {
  MESSAGING_SETTINGS_DEFAULTS,
  mergeMessagingEvent,
  type MessagingSettings,
} from "@/lib/messaging/venue-settings";

const NEW_CONFIG = {
  enabled: false,
  channels: ["email" as const],
  hoursBeforeStart: 48,
};

describe("mergeMessagingEvent", () => {
  it("keeps sibling events' stored (non-default) config untouched", () => {
    const stored = {
      messaging: {
        confirmation: { enabled: false, channels: ["sms"] },
        thank_you: { enabled: true, channels: ["whatsapp", "email"], hoursAfterFinish: 6 },
      },
    };
    const out = mergeMessagingEvent(stored, "reminder_24h", NEW_CONFIG);
    const messaging = out["messaging"] as MessagingSettings;
    expect(messaging.reminder_24h).toEqual(NEW_CONFIG);
    expect(messaging.confirmation).toEqual({ enabled: false, channels: ["sms"] });
    expect(messaging.thank_you).toEqual({
      enabled: true,
      channels: ["whatsapp", "email"],
      hoursAfterFinish: 6,
    });
  });

  it("preserves branding and unknown root keys verbatim", () => {
    const stored = {
      branding: { logoUrl: "https://x.test/l.png", brandColour: "#c2410c" },
      someFutureKey: { a: 1 },
      messaging: {},
    };
    const out = mergeMessagingEvent(stored, "confirmation", NEW_CONFIG);
    expect(out["branding"]).toEqual(stored.branding);
    expect(out["someFutureKey"]).toEqual(stored.someFutureKey);
  });

  it("round-trips empty settings to shipped defaults plus the saved event", () => {
    const out = mergeMessagingEvent({}, "reminder_2h", NEW_CONFIG);
    const messaging = out["messaging"] as MessagingSettings;
    expect(messaging.reminder_2h).toEqual(NEW_CONFIG);
    expect(messaging.confirmation).toEqual(MESSAGING_SETTINGS_DEFAULTS.confirmation);
    expect(messaging.cancelled).toEqual(MESSAGING_SETTINGS_DEFAULTS.cancelled);
    expect(messaging.thank_you).toEqual(MESSAGING_SETTINGS_DEFAULTS.thank_you);
  });

  it("tolerates null / non-object settings", () => {
    for (const settings of [null, undefined, "junk", 42]) {
      const out = mergeMessagingEvent(settings, "confirmation", NEW_CONFIG);
      const messaging = out["messaging"] as MessagingSettings;
      expect(messaging.confirmation).toEqual(NEW_CONFIG);
      expect(messaging.reminder_24h).toEqual(MESSAGING_SETTINGS_DEFAULTS.reminder_24h);
    }
  });

  it("degrades a malformed sibling to its default rather than propagating junk", () => {
    const stored = { messaging: { confirmation: { enabled: "yes", channels: [] } } };
    const out = mergeMessagingEvent(stored, "thank_you", NEW_CONFIG);
    const messaging = out["messaging"] as MessagingSettings;
    expect(messaging.confirmation).toEqual(MESSAGING_SETTINGS_DEFAULTS.confirmation);
  });
});
