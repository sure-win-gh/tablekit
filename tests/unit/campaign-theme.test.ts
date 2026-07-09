// Theme layer + per-block styling (marketing-suite customisation):
// schema strictness (hex-only colours, enum fonts — no CSS injection) and
// renderer precedence (block override → theme → venue branding → default).

import { describe, expect, it } from "vitest";

import { parseBodyDoc } from "@/lib/campaigns/blocks";
import { renderCampaign } from "@/lib/campaigns/render";

const ctx = {
  guestFirstName: "Jamie",
  venueName: "Jane's Café",
  unsubscribeUrl: "https://example.test/unsubscribe?p=abc",
};

describe("theme + style schema", () => {
  it("accepts a full theme and styled blocks", () => {
    const r = parseBodyDoc({
      v: 1,
      theme: { font: "classic", accent: "#b3541e", textColour: "#222222", buttonShape: "pill" },
      blocks: [
        { type: "heading", text: "Hi", level: 1, colour: "#004225", align: "center" },
        { type: "text", text: "Body", size: "l", align: "center", colour: "#333333" },
        {
          type: "button",
          label: "Go",
          url: "https://x.example",
          style: "filled",
          colour: "#aa0000",
          align: "center",
        },
        { type: "divider", colour: "#cccccc" },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects non-hex colours (no CSS injection through colour fields)", () => {
    for (const doc of [
      { v: 1, theme: { accent: "red" }, blocks: [{ type: "divider" }] },
      { v: 1, theme: { accent: "#fff" }, blocks: [{ type: "divider" }] },
      { v: 1, theme: { accent: "#111111;background:url(x)" }, blocks: [{ type: "divider" }] },
      { v: 1, blocks: [{ type: "heading", text: "x", colour: "expression(alert(1))" }] },
    ]) {
      expect(parseBodyDoc(doc).ok).toBe(false);
    }
  });

  it("rejects unknown fonts, shapes and alignments", () => {
    expect(
      parseBodyDoc({ v: 1, theme: { font: "comic-sans" }, blocks: [{ type: "divider" }] }).ok,
    ).toBe(false);
    expect(
      parseBodyDoc({ v: 1, theme: { buttonShape: "blob" }, blocks: [{ type: "divider" }] }).ok,
    ).toBe(false);
    expect(parseBodyDoc({ v: 1, blocks: [{ type: "text", text: "x", align: "right" }] }).ok).toBe(
      false,
    );
  });
});

describe("themed rendering", () => {
  it("applies the theme font, colours and button shape", async () => {
    const r = await renderCampaign({
      channel: "email",
      subject: null,
      body: "x",
      bodyDoc: {
        v: 1,
        theme: { font: "classic", accent: "#b3541e", textColour: "#444444", buttonShape: "pill" },
        blocks: [
          { type: "heading", text: "Supper club", level: 1 },
          { type: "text", text: "Join us." },
          { type: "button", label: "Book", url: "https://x.example", style: "filled" },
        ],
      },
      ctx,
    });
    if (r.kind !== "email") return;
    expect(r.rendered.html).toContain("Georgia"); // classic stack
    expect(r.rendered.html).toContain("#b3541e"); // accent on heading + button
    expect(r.rendered.html).toContain("#444444"); // theme text colour
    expect(r.rendered.html).toContain("border-radius:999px"); // pill
  });

  it("block overrides beat the theme; theme beats venue branding", async () => {
    const r = await renderCampaign({
      channel: "email",
      subject: null,
      body: "x",
      bodyDoc: {
        v: 1,
        theme: { accent: "#b3541e" },
        blocks: [
          { type: "heading", text: "Override", colour: "#004225", align: "center", level: 2 },
          { type: "button", label: "Themed", url: "https://x.example", style: "filled" },
        ],
      },
      ctx: { ...ctx, branding: { brandColour: "#123456" } },
    });
    if (r.kind !== "email") return;
    expect(r.rendered.html).toContain("#004225"); // block override on heading
    expect(r.rendered.html).toContain("#b3541e"); // theme accent on button
    expect(r.rendered.html).toContain("text-align:center");
  });

  it("no theme → venue brand colour still drives the accent (pre-theme docs unchanged)", async () => {
    const r = await renderCampaign({
      channel: "email",
      subject: null,
      body: "x",
      bodyDoc: {
        v: 1,
        blocks: [{ type: "button", label: "Brand", url: "https://x.example", style: "filled" }],
      },
      ctx: { ...ctx, branding: { brandColour: "#123456" } },
    });
    if (r.kind !== "email") return;
    expect(r.rendered.html).toContain("#123456");
    expect(r.rendered.html).toContain("border-radius:6px"); // default rounded
  });
});
