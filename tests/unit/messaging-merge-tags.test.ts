// Phase 2c — merge-tag interpolation + override rendering. Verifies the
// closed tag set substitutes safely, unknown tags are flagged + left
// literal, operator copy can't inject markup, and the override render
// layer re-applies the locked unsubscribe/STOP elements.

import { describe, expect, it } from "vitest";

import type { MessageBookingContext } from "@/lib/messaging/context";
import {
  findUnknownMergeTags,
  interpolateMergeTags,
  escapeHtml,
  MERGE_TAG_NAMES,
} from "@/lib/messaging/merge-tags";
import { renderMessage } from "@/lib/messaging/render-message";

const ctx: MessageBookingContext = {
  bookingId: "00000000-0000-0000-0000-000000000001",
  reference: "ABC-123",
  guestFirstName: "Jane",
  partySize: 4,
  startAtLocal: "Mon 1 Jun 2026, 7:00 PM",
  endAtLocal: "Mon 1 Jun 2026, 8:30 PM",
  venueName: "Tablekit Café",
  venueLocale: "en-GB",
  serviceName: "Dinner",
  notes: null,
  unsubscribeUrl: "https://example.test/unsubscribe?p=abc&s=def",
  reviewUrl: "https://example.test/review?p=abc",
};

describe("interpolateMergeTags", () => {
  it("substitutes known tags (with surrounding whitespace tolerated)", () => {
    expect(interpolateMergeTags("Hi {{guestFirstName}}, party of {{ partySize }}", ctx)).toBe(
      "Hi Jane, party of 4",
    );
  });

  it("leaves unknown tags literal and reports them", () => {
    const tpl = "Hi {{guestFirstName}}, your {{discountCode}} awaits";
    expect(interpolateMergeTags(tpl, ctx)).toBe("Hi Jane, your {{discountCode}} awaits");
    expect(findUnknownMergeTags(tpl)).toEqual(["discountCode"]);
  });

  it("exposes the closed tag-name set", () => {
    expect(MERGE_TAG_NAMES).toContain("venueName");
    expect(MERGE_TAG_NAMES).toContain("reference");
  });
});

describe("escapeHtml", () => {
  it("neutralises markup", () => {
    expect(escapeHtml(`<script>alert('x')</script>`)).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;",
    );
  });
});

describe("renderMessage — overrides", () => {
  it("falls back to the registry renderer when no override is set", async () => {
    const r = await renderMessage("booking.confirmation", "email", ctx, null);
    expect(r.kind).toBe("email");
    if (r.kind !== "email") return;
    // Shipped default copy.
    expect(r.rendered.html).toContain("Jane");
  });

  it("renders an SMS override and force-appends the STOP line", async () => {
    const r = await renderMessage("booking.reminder_2h", "sms", ctx, {
      subjectOverride: null,
      bodyOverride: "See you at {{startAtLocal}}, {{guestFirstName}}!",
      enabled: true,
    });
    expect(r.kind).toBe("sms");
    if (r.kind !== "sms") return;
    expect(r.rendered.body).toContain("Mon 1 Jun 2026, 7:00 PM");
    expect(r.rendered.body).toMatch(/STOP/);
  });

  it("does not double-append STOP if the operator already included it", async () => {
    const r = await renderMessage("booking.reminder_2h", "sms", ctx, {
      subjectOverride: null,
      bodyOverride: "Bye. Reply STOP to opt out.",
      enabled: true,
    });
    expect(r.kind).toBe("sms");
    if (r.kind !== "sms") return;
    expect(r.rendered.body.match(/STOP/g)?.length).toBe(1);
  });

  it("renders an email override inside the branded layout with the unsubscribe footer", async () => {
    const r = await renderMessage("booking.confirmation", "email", ctx, {
      subjectOverride: "Your table at {{venueName}}",
      bodyOverride: "Hi {{guestFirstName}},\n\nCan't wait to see you.",
      enabled: true,
    });
    expect(r.kind).toBe("email");
    if (r.kind !== "email") return;
    expect(r.rendered.subject).toBe("Your table at Tablekit Café");
    expect(r.rendered.html).toContain("Hi Jane,");
    // Locked element: unsubscribe footer always present.
    expect(r.rendered.html).toContain("Unsubscribe");
  });

  it("escapes operator markup in an email override (no injection)", async () => {
    const r = await renderMessage("booking.confirmation", "email", ctx, {
      subjectOverride: null,
      bodyOverride: "<script>alert(1)</script>",
      enabled: true,
    });
    expect(r.kind).toBe("email");
    if (r.kind !== "email") return;
    expect(r.rendered.html).not.toContain("<script>alert(1)</script>");
  });

  it("ignores a disabled override (falls back to default)", async () => {
    const r = await renderMessage("booking.confirmation", "email", ctx, {
      subjectOverride: "Custom",
      bodyOverride: "Custom body",
      enabled: false,
    });
    expect(r.kind).toBe("email");
    if (r.kind !== "email") return;
    expect(r.rendered.subject).not.toBe("Custom");
  });
});
