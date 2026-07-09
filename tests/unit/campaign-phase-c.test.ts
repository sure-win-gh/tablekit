// Marketing suite Phase C — bookingCta / countdown / social blocks: schema
// validation, the signed countdown token + GIF encoder, and rendering.

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseBodyDoc } from "@/lib/campaigns/blocks";
import {
  countdownText,
  renderCountdownGif,
  signCountdown,
  verifyCountdown,
} from "@/lib/campaigns/countdown";
import { renderCampaign } from "@/lib/campaigns/render";

const ORIGIN = "https://book.tablekit.uk";
const CID = "3b9f2b6a-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

describe("Phase C block schemas", () => {
  it("accepts a bookingCta with prefill and bounds the party size", () => {
    expect(
      parseBodyDoc({
        v: 1,
        blocks: [{ type: "bookingCta", label: "Book now", party: 4, date: "2026-08-01" }],
      }).ok,
    ).toBe(true);
    expect(
      parseBodyDoc({ v: 1, blocks: [{ type: "bookingCta", label: "Book", party: 21 }] }).ok,
    ).toBe(false);
    expect(
      parseBodyDoc({ v: 1, blocks: [{ type: "bookingCta", label: "Book", date: "01/08/2026" }] })
        .ok,
    ).toBe(false);
  });

  it("countdown requires a parseable target", () => {
    expect(
      parseBodyDoc({ v: 1, blocks: [{ type: "countdown", target: "2026-08-01T19:00" }] }).ok,
    ).toBe(true);
    expect(parseBodyDoc({ v: 1, blocks: [{ type: "countdown", target: "soon" }] }).ok).toBe(false);
  });

  it("social needs at least one http(s) link", () => {
    expect(
      parseBodyDoc({
        v: 1,
        blocks: [{ type: "social", instagram: "https://instagram.com/janes" }],
      }).ok,
    ).toBe(true);
    expect(parseBodyDoc({ v: 1, blocks: [{ type: "social" }] }).ok).toBe(false);
    expect(
      parseBodyDoc({ v: 1, blocks: [{ type: "social", instagram: "javascript:alert(1)" }] }).ok,
    ).toBe(false);
  });
});

describe("countdown token + text", () => {
  it("signs and verifies a payload; tampering fails", () => {
    const token = signCountdown({ targetMs: 1786000000000, campaignId: CID });
    const back = verifyCountdown(token);
    expect(back).toEqual({ targetMs: 1786000000000, campaignId: CID });
    expect(verifyCountdown(token.slice(0, -2))).toBeNull();
    expect(verifyCountdown("garbage")).toBeNull();
  });

  it("token carries no guest identifiers (target + campaign only)", () => {
    const token = signCountdown({ targetMs: 123 });
    expect(verifyCountdown(token)).toEqual({ targetMs: 123 });
  });

  it("formats remaining time and the finished state", () => {
    const now = Date.UTC(2026, 6, 7, 12, 0, 0);
    expect(countdownText(now + (3 * 86_400 + 12 * 3600 + 45 * 60) * 1000, now)).toBe("3D 12H 45M");
    expect(countdownText(now + (2 * 3600 + 5 * 60 + 9) * 1000, now)).toBe("02:05:09");
    expect(countdownText(now - 1, now)).toBe("IT'S ON!");
  });
});

describe("countdown GIF encoder", () => {
  it("produces a structurally valid single-frame GIF", () => {
    const now = Date.now();
    const gif = renderCountdownGif(now + 86_400_000, now);
    expect(gif.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(gif[gif.length - 1]).toBe(0x3b); // trailer
    const width = gif[6]! | (gif[7]! << 8);
    const height = gif[8]! | (gif[9]! << 8);
    expect(width).toBeGreaterThan(0);
    expect(height).toBe(7 * 6 + 28); // 7 rows × scale 6 + 2×14 padding
    expect(gif.length).toBeLessThan(120_000); // stays email-friendly
  });
});

describe("rendering Phase C blocks", () => {
  afterEach(() => vi.unstubAllEnvs());

  const ctx = {
    guestFirstName: "Jamie",
    venueName: "Jane's Café",
    unsubscribeUrl: `${ORIGIN}/unsubscribe?p=abc`,
    bookingUrl: `${ORIGIN}/book/janes-cafe`,
    appUrl: "https://app.tablekit.uk",
  };

  it("bookingCta builds the prefilled booking URL and carries attribution on real sends", async () => {
    vi.stubEnv("NEXT_PUBLIC_WIDGET_URL", ORIGIN);
    const r = await renderCampaign({
      channel: "email",
      subject: null,
      body: "x",
      bodyDoc: {
        v: 1,
        blocks: [
          {
            type: "bookingCta",
            label: "Book for {{venueName}}",
            party: 4,
            date: "2026-08-01",
            style: "filled",
          },
        ],
      },
      ctx: { ...ctx, campaignId: CID },
    });
    if (r.kind !== "email") return;
    expect(r.rendered.html).toContain("/book/janes-cafe");
    expect(r.rendered.html).toContain("party=4");
    expect(r.rendered.html).toContain("date=2026-08-01");
    expect(r.rendered.html).toContain(`tk_c=${CID}`);
    expect(r.rendered.html).toContain("Book for Jane&#x27;s Café");
  });

  it("countdown renders the signed image; social renders links; missing surfaces render nothing", async () => {
    const r = await renderCampaign({
      channel: "email",
      subject: null,
      body: "x",
      bodyDoc: {
        v: 1,
        blocks: [
          { type: "countdown", target: "2027-01-01T00:00:00Z", caption: "Doors open in" },
          {
            type: "social",
            instagram: "https://instagram.com/janes",
            website: "https://janes.example",
          },
        ],
      },
      ctx,
    });
    if (r.kind !== "email") return;
    expect(r.rendered.html).toContain("https://app.tablekit.uk/api/countdown/");
    expect(r.rendered.html).toContain("Doors open in");
    expect(r.rendered.html).toContain('href="https://instagram.com/janes"');

    // Without bookingUrl/appUrl the blocks are omitted, never broken links.
    const bare = await renderCampaign({
      channel: "email",
      subject: null,
      body: "x",
      bodyDoc: {
        v: 1,
        blocks: [
          { type: "bookingCta", label: "Book", style: "filled" },
          { type: "countdown", target: "2027-01-01T00:00:00Z" },
          { type: "text", text: "still here" },
        ],
      },
      ctx: { ...ctx, bookingUrl: undefined, appUrl: undefined },
    });
    if (bare.kind !== "email") return;
    expect(bare.rendered.html).not.toContain("/api/countdown/");
    expect(bare.rendered.html).toContain("still here");
  });
});
