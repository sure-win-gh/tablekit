// Marketing suite Phase A — block schema validation + doc rendering.
// docs/specs/marketing-suite.md acceptance criteria: zod-validated at the
// boundary, no stored-XSS via block fields, http(s)-only URLs, plain-text
// part, non-removable unsubscribe footer, merge tags in blocks.

import { describe, expect, it } from "vitest";

import {
  MAX_BLOCKS,
  docTemplateStrings,
  docToPlainText,
  parseBodyDoc,
  type CampaignBodyDoc,
} from "@/lib/campaigns/blocks";
import { renderCampaign } from "@/lib/campaigns/render";

const ctx = {
  guestFirstName: "Jamie",
  venueName: "Jane's Café",
  unsubscribeUrl: "https://example.test/unsubscribe?p=abc",
};

const validDoc = {
  v: 1,
  blocks: [
    { type: "heading", text: "June supper club", level: 1 },
    {
      type: "text",
      text: "Hi {{guestFirstName}},\n\nCome and see **us** at [the café](https://janes.example).",
    },
    { type: "image", src: "https://cdn.example/hero.jpg", alt: "Our terrace", widthPct: 100 },
    { type: "divider" },
    { type: "button", label: "Book a table", url: "https://book.example/janes", style: "filled" },
    { type: "spacer", size: "m" },
  ],
};

describe("parseBodyDoc", () => {
  it("accepts a valid doc", () => {
    const r = parseBodyDoc(validDoc);
    expect(r.ok).toBe(true);
  });

  it("rejects javascript: URLs in buttons and images", () => {
    for (const doc of [
      { v: 1, blocks: [{ type: "button", label: "x", url: "javascript:alert(1)" }] },
      { v: 1, blocks: [{ type: "image", src: "javascript:alert(1)", alt: "x" }] },
      { v: 1, blocks: [{ type: "image", src: "data:text/html,hi", alt: "x" }] },
    ]) {
      expect(parseBodyDoc(doc).ok).toBe(false);
    }
  });

  it("requires image alt text", () => {
    expect(
      parseBodyDoc({ v: 1, blocks: [{ type: "image", src: "https://x.example/a.png" }] }).ok,
    ).toBe(false);
  });

  it("rejects an empty doc, an unknown block type, and a wrong version", () => {
    expect(parseBodyDoc({ v: 1, blocks: [] }).ok).toBe(false);
    expect(parseBodyDoc({ v: 1, blocks: [{ type: "marquee", text: "hi" }] }).ok).toBe(false);
    expect(parseBodyDoc({ v: 2, blocks: validDoc.blocks }).ok).toBe(false);
  });

  it(`caps the doc at ${MAX_BLOCKS} blocks`, () => {
    const blocks = Array.from({ length: MAX_BLOCKS + 1 }, () => ({ type: "divider" }));
    expect(parseBodyDoc({ v: 1, blocks }).ok).toBe(false);
  });

  it("caps text length", () => {
    expect(parseBodyDoc({ v: 1, blocks: [{ type: "text", text: "x".repeat(2001) }] }).ok).toBe(
      false,
    );
  });
});

describe("doc projections", () => {
  const doc = (parseBodyDoc(validDoc) as { ok: true; doc: CampaignBodyDoc }).doc;

  it("collects operator template strings for merge-tag validation", () => {
    const strings = docTemplateStrings(doc);
    expect(strings).toContain("June supper club");
    expect(strings).toContain("Book a table");
    expect(strings.some((s) => s.includes("{{guestFirstName}}"))).toBe(true);
  });

  it("projects a plain-text body", () => {
    const text = docToPlainText(doc);
    expect(text).toContain("June supper club");
    expect(text).toContain("Book a table: https://book.example/janes");
    expect(text).toContain("Our terrace");
  });
});

describe("renderCampaign with a block doc", () => {
  const doc = (parseBodyDoc(validDoc) as { ok: true; doc: CampaignBodyDoc }).doc;

  it("renders blocks with merge tags, inline marks, button href and the unsubscribe footer", async () => {
    const r = await renderCampaign({
      channel: "email",
      subject: null,
      body: docToPlainText(doc),
      bodyDoc: doc,
      ctx,
    });
    expect(r.kind).toBe("email");
    if (r.kind !== "email") return;
    expect(r.rendered.html).toContain("June supper club");
    expect(r.rendered.html).toContain("Hi Jamie,");
    expect(r.rendered.html).toContain("<strong>us</strong>");
    expect(r.rendered.html).toContain('href="https://janes.example"');
    expect(r.rendered.html).toContain('href="https://book.example/janes"');
    expect(r.rendered.html).toContain('alt="Our terrace"');
    expect(r.rendered.html).toContain("Unsubscribe");
    // Plain-text MIME part is produced from the same blocks (react-email
    // upper-cases headings in plain text).
    expect(r.rendered.text.toLowerCase()).toContain("june supper club");
    expect(r.rendered.text).toContain("Hi Jamie,");
  });

  it("escapes markup smuggled into block text (no stored XSS)", async () => {
    const hostile = parseBodyDoc({
      v: 1,
      blocks: [
        { type: "heading", text: "<script>alert(1)</script>", level: 2 },
        { type: "text", text: "<img src=x onerror=alert(1)>" },
      ],
    });
    expect(hostile.ok).toBe(true);
    if (!hostile.ok) return;
    const r = await renderCampaign({
      channel: "email",
      subject: null,
      body: "x",
      bodyDoc: hostile.doc,
      ctx,
    });
    if (r.kind !== "email") return;
    expect(r.rendered.html).not.toContain("<script>alert(1)</script>");
    expect(r.rendered.html).not.toContain("<img src=x onerror");
  });

  it("legacy campaigns (no doc) render exactly as before", async () => {
    const r = await renderCampaign({
      channel: "email",
      subject: null,
      body: "Hi {{guestFirstName}},\n\nCome see us.",
      ctx,
    });
    if (r.kind !== "email") return;
    expect(r.rendered.html).toContain("Hi Jamie,");
    expect(r.rendered.html).toContain("Unsubscribe");
  });
});
