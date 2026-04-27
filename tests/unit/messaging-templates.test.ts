// Smoke tests for the messaging template registry. Locks the channel
// map (so a template doesn't silently lose a renderer in a refactor)
// and confirms each shipped renderer produces non-empty output for a
// realistic context.

import { describe, expect, it } from "vitest";

import type { MessageBookingContext } from "@/lib/messaging/context";
import { renderForChannel, templateChannels } from "@/lib/messaging/registry";

const ctx: MessageBookingContext = {
  bookingId: "00000000-0000-0000-0000-000000000001",
  reference: "ABC-123",
  guestFirstName: "Jane",
  partySize: 2,
  startAtLocal: "Mon 1 Jun 2026, 7:00 PM",
  endAtLocal: "Mon 1 Jun 2026, 8:30 PM",
  venueName: "Tablekit Café",
  venueLocale: "en-GB",
  serviceName: "Dinner",
  notes: null,
  unsubscribeUrl: "https://example.test/unsubscribe?t=abc",
  reviewUrl: "https://example.test/review?p=abc&s=def",
};

describe("templateChannels", () => {
  it("registers expected channels per template", () => {
    expect(templateChannels("booking.confirmation")).toEqual(["email"]);
    expect(templateChannels("booking.reminder_24h")).toEqual(["email"]);
    expect(templateChannels("booking.reminder_2h")).toEqual(["sms"]);
    expect(templateChannels("booking.cancelled")).toEqual(["email"]);
    expect(templateChannels("booking.thank_you")).toEqual(["email"]);
    expect(templateChannels("booking.waitlist_ready")).toEqual(["sms"]);
    expect(templateChannels("booking.review_request")).toEqual(["email"]);
    expect(templateChannels("review.recovery_offer")).toEqual(["email"]);
  });
});

describe("renderForChannel", () => {
  it("renders booking.confirmation email with subject + html + text", async () => {
    const r = await renderForChannel("booking.confirmation", "email", ctx);
    expect(r.kind).toBe("email");
    if (r.kind !== "email") return;
    expect(r.rendered.subject).toContain("Tablekit Café");
    expect(r.rendered.html).toContain("ABC-123");
    expect(r.rendered.html).toContain("Jane");
    expect(r.rendered.text.length).toBeGreaterThan(20);
  });

  it("renders booking.reminder_24h", async () => {
    const r = await renderForChannel("booking.reminder_24h", "email", ctx);
    expect(r.kind).toBe("email");
    if (r.kind !== "email") return;
    expect(r.rendered.subject.toLowerCase()).toContain("tomorrow");
  });

  it("renders booking.cancelled with cancellation reason when given", async () => {
    const withReason = { ...ctx, cancellationReason: "Guest emailed; rescheduling" };
    const r = await renderForChannel("booking.cancelled", "email", withReason);
    expect(r.kind).toBe("email");
    if (r.kind !== "email") return;
    expect(r.rendered.html).toContain("Guest emailed");
  });

  it("renders booking.thank_you", async () => {
    const r = await renderForChannel("booking.thank_you", "email", ctx);
    expect(r.kind).toBe("email");
  });

  it("renders review.recovery_offer with the operator's message", async () => {
    const r = await renderForChannel("review.recovery_offer", "email", {
      ...ctx,
      recoveryMessageText: "Sorry your starter was cold. Dinner's on us next time.",
    });
    expect(r.kind).toBe("email");
    if (r.kind !== "email") return;
    expect(r.rendered.subject).toContain("Tablekit Café");
    expect(r.rendered.html).toContain("Dinner&#x27;s on us next time");
  });

  it("renders booking.review_request with both public and private CTAs", async () => {
    const r = await renderForChannel("booking.review_request", "email", ctx);
    expect(r.kind).toBe("email");
    if (r.kind !== "email") return;
    expect(r.rendered.subject).toContain("Tablekit Café");
    // `&` is HTML-encoded in the rendered output, so check the path
    // and the private-mode marker independently.
    expect(r.rendered.html).toContain("https://example.test/review?p=abc");
    expect(r.rendered.html).toContain("mode=private");
  });

  it("renders booking.reminder_2h SMS body within one segment when names are short", () => {
    return renderForChannel("booking.reminder_2h", "sms", ctx).then((r) => {
      expect(r.kind).toBe("sms");
      if (r.kind !== "sms") return;
      expect(r.rendered.body).toContain("ABC-123");
      expect(r.rendered.body).toContain("STOP");
      // Soft check — single GSM-7 segment is 160 chars; we aim for it
      // but a long venue name + party size could push over. Cap at
      // 160 in the assertion when the fixture's venue name is short.
      expect(r.rendered.body.length).toBeLessThanOrEqual(160);
    });
  });

  it("renders booking.waitlist_ready SMS body", async () => {
    const r = await renderForChannel("booking.waitlist_ready", "sms", ctx);
    expect(r.kind).toBe("sms");
    if (r.kind !== "sms") return;
    expect(r.rendered.body).toContain("table for 2 is ready");
    expect(r.rendered.body).toContain("STOP");
    expect(r.rendered.body.length).toBeLessThanOrEqual(160);
  });

  it("returns no-renderer for a template/channel combo that's not registered", async () => {
    // confirmation is email-only; SMS isn't registered for it.
    const r = await renderForChannel("booking.confirmation", "sms", ctx);
    expect(r.kind).toBe("no-renderer");
  });
});
