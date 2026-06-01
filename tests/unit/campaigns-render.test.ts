// Phase 3 — marketing render + usage helpers.

import { describe, expect, it } from "vitest";

import {
  findUnknownMarketingTags,
  renderCampaign,
  MARKETING_TAG_NAMES,
} from "@/lib/campaigns/render";
import { billingPeriod, estimateCostPence, CHANNEL_COST_PENCE } from "@/lib/campaigns/usage";

const ctx = {
  guestFirstName: "Jamie",
  venueName: "Jane's Café",
  unsubscribeUrl: "https://example.test/unsubscribe?p=abc",
};

describe("marketing merge tags", () => {
  it("exposes only the marketing tag set", () => {
    expect(MARKETING_TAG_NAMES).toEqual(["guestFirstName", "venueName"]);
  });

  it("reports unknown tags (booking-only tags are unknown here)", () => {
    expect(findUnknownMarketingTags("Hi {{guestFirstName}} for {{partySize}}")).toEqual([
      "partySize",
    ]);
  });
});

describe("renderCampaign", () => {
  it("renders an email with merge tags + unsubscribe footer", async () => {
    const r = await renderCampaign({
      channel: "email",
      subject: "A note from {{venueName}}",
      body: "Hi {{guestFirstName}},\n\nCome see us.",
      ctx,
    });
    expect(r.kind).toBe("email");
    if (r.kind !== "email") return;
    expect(r.rendered.subject).toBe("A note from Jane's Café");
    expect(r.rendered.html).toContain("Hi Jamie,");
    expect(r.rendered.html).toContain("Unsubscribe");
  });

  it("always appends the STOP line on SMS", async () => {
    const r = await renderCampaign({
      channel: "sms",
      subject: null,
      body: "Flash sale at {{venueName}}!",
      ctx,
    });
    expect(r.kind).toBe("sms");
    if (r.kind !== "sms") return;
    expect(r.rendered.body).toContain("Jane's Café");
    expect(r.rendered.body).toMatch(/STOP/);
  });

  it("appends the STOP line on WhatsApp too", async () => {
    const r = await renderCampaign({ channel: "whatsapp", subject: null, body: "Hello!", ctx });
    expect(r.kind).toBe("whatsapp");
    if (r.kind !== "whatsapp") return;
    expect(r.rendered.body).toMatch(/STOP/);
  });

  it("escapes operator markup in the email body", async () => {
    const r = await renderCampaign({
      channel: "email",
      subject: null,
      body: "<script>alert(1)</script>",
      ctx,
    });
    expect(r.kind).toBe("email");
    if (r.kind !== "email") return;
    expect(r.rendered.html).not.toContain("<script>alert(1)</script>");
  });
});

describe("usage helpers", () => {
  it("formats the UTC billing period", () => {
    expect(billingPeriod(new Date("2026-06-09T23:30:00Z"))).toBe("2026-06");
    expect(billingPeriod(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
  });

  it("estimates cost from the channel rate card", () => {
    expect(estimateCostPence("email", 1000)).toBe(0);
    expect(estimateCostPence("sms", 10)).toBe(CHANNEL_COST_PENCE.sms * 10);
    expect(estimateCostPence("whatsapp", 5)).toBe(CHANNEL_COST_PENCE.whatsapp * 5);
    expect(estimateCostPence("sms", -3)).toBe(0);
  });
});
