// Marketing suite Phase B — link attribution unit coverage: the tk_c URL
// helper, the wizard URL contract carrying the param, and the renderer
// stamping booking links on real sends only.

import { afterEach, describe, expect, it, vi } from "vitest";

import { appendCampaignParam, isBookingSurfaceUrl } from "@/lib/campaigns/links";
import { renderCampaign } from "@/lib/campaigns/render";
import { buildStepUrl, deriveStep, validCampaign } from "@/lib/public/wizard-step";

const CID = "3b9f2b6a-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const ORIGIN = "https://book.tablekit.uk";

describe("appendCampaignParam", () => {
  it("appends tk_c to booking-surface URLs on the widget origin", () => {
    expect(appendCampaignParam(`${ORIGIN}/book/janes-cafe`, CID, ORIGIN)).toBe(
      `${ORIGIN}/book/janes-cafe?tk_c=${CID}`,
    );
    expect(appendCampaignParam(`${ORIGIN}/embed/janes-cafe`, CID, ORIGIN)).toContain(`tk_c=${CID}`);
  });

  it("preserves existing query params and never duplicates tk_c", () => {
    const withParams = appendCampaignParam(`${ORIGIN}/book/janes?party=4`, CID, ORIGIN);
    expect(withParams).toContain("party=4");
    expect(withParams).toContain(`tk_c=${CID}`);
    const already = `${ORIGIN}/book/janes?tk_c=other`;
    expect(appendCampaignParam(already, CID, ORIGIN)).toBe(already);
  });

  it("leaves non-booking URLs untouched", () => {
    for (const url of [
      "https://janes-cafe.example/menu", // other origin
      `${ORIGIN}/unsubscribe?p=x`, // our origin, not a booking path
      "not a url",
    ]) {
      expect(appendCampaignParam(url, CID, ORIGIN)).toBe(url);
    }
  });

  it("is a no-op without a campaign id or widget origin", () => {
    expect(appendCampaignParam(`${ORIGIN}/book/janes`, undefined, ORIGIN)).toBe(
      `${ORIGIN}/book/janes`,
    );
    expect(appendCampaignParam(`${ORIGIN}/book/janes`, CID, "")).toBe(`${ORIGIN}/book/janes`);
  });

  it("isBookingSurfaceUrl matches only /book/ and /embed/ on the origin", () => {
    expect(isBookingSurfaceUrl(`${ORIGIN}/book/x`, ORIGIN)).toBe(true);
    expect(isBookingSurfaceUrl(`${ORIGIN}/booking/x`, ORIGIN)).toBe(false);
    expect(isBookingSurfaceUrl(`https://evil.example/book/x`, ORIGIN)).toBe(false);
  });
});

describe("wizard URL contract carries tk_c", () => {
  it("validCampaign accepts uuids only", () => {
    expect(validCampaign(CID)).toBe(CID);
    expect(validCampaign(CID.toUpperCase())).toBe(CID);
    expect(validCampaign("<script>")).toBeUndefined();
    expect(validCampaign("")).toBeUndefined();
  });

  it("deriveStep keeps campaign at every step and buildStepUrl round-trips it", () => {
    for (const sp of [
      { tk_c: CID }, // party step
      { tk_c: CID, party: "4" }, // date step
      { tk_c: CID, party: "4", date: "2026-08-01" }, // time step
      { tk_c: CID, party: "4", date: "2026-08-01", serviceId: "svc", wallStart: "19:00" }, // details
    ]) {
      const { params } = deriveStep(sp);
      expect(params.campaign).toBe(CID);
      expect(buildStepUrl(params)).toContain(`tk_c=${CID}`);
    }
  });

  it("drops a malformed tk_c instead of propagating it", () => {
    const { params } = deriveStep({ tk_c: "javascript:alert(1)", party: "2" });
    expect(params.campaign).toBeUndefined();
    expect(buildStepUrl(params)).not.toContain("tk_c");
  });
});

describe("renderCampaign stamps booking links", () => {
  afterEach(() => vi.unstubAllEnvs());

  const ctxBase = {
    guestFirstName: "Jamie",
    venueName: "Jane's Café",
    unsubscribeUrl: `${ORIGIN}/unsubscribe?p=abc`,
  };

  it("adds tk_c to a booking button + inline booking link on a real send", async () => {
    vi.stubEnv("NEXT_PUBLIC_WIDGET_URL", ORIGIN);
    const r = await renderCampaign({
      channel: "email",
      subject: null,
      body: "x",
      bodyDoc: {
        v: 1,
        blocks: [
          {
            type: "text",
            text: `Reserve [here](${ORIGIN}/book/janes) or on [our site](https://janes.example)`,
          },
          { type: "button", label: "Book", url: `${ORIGIN}/book/janes`, style: "filled" },
        ],
      },
      ctx: { ...ctxBase, campaignId: CID },
    });
    if (r.kind !== "email") return;
    expect(r.rendered.html).toContain(`tk_c=${CID}`);
    // The external link stays clean.
    expect(r.rendered.html).toContain('href="https://janes.example"');
  });

  it("does NOT stamp links on previews/test-sends (no campaignId)", async () => {
    vi.stubEnv("NEXT_PUBLIC_WIDGET_URL", ORIGIN);
    const r = await renderCampaign({
      channel: "email",
      subject: null,
      body: "x",
      bodyDoc: {
        v: 1,
        blocks: [{ type: "button", label: "Book", url: `${ORIGIN}/book/janes`, style: "filled" }],
      },
      ctx: ctxBase,
    });
    if (r.kind !== "email") return;
    expect(r.rendered.html).not.toContain("tk_c=");
  });
});
