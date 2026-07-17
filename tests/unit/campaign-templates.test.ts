// Starter templates — every seeded design must validate against the live
// block schema (so a schema change can never ship a broken starter) and
// must only use known marketing merge tags.

import { describe, expect, it } from "vitest";

import { docTemplateStrings, parseBodyDoc } from "@/lib/campaigns/blocks";
import { findUnknownMarketingTags } from "@/lib/campaigns/render";
import { STARTER_TEMPLATES } from "@/lib/campaigns/starter-templates";

describe("starter templates", () => {
  it("ships at least three starters with unique keys and names", () => {
    expect(STARTER_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(STARTER_TEMPLATES.map((s) => s.key)).size).toBe(STARTER_TEMPLATES.length);
    expect(new Set(STARTER_TEMPLATES.map((s) => s.name)).size).toBe(STARTER_TEMPLATES.length);
  });

  it("every starter doc passes the block schema", () => {
    for (const s of STARTER_TEMPLATES) {
      const r = parseBodyDoc(s.doc);
      expect(r.ok, `starter "${s.key}" failed schema validation`).toBe(true);
    }
  });

  it("starters use only known merge tags (copy + subject)", () => {
    for (const s of STARTER_TEMPLATES) {
      const parsed = parseBodyDoc(s.doc);
      if (!parsed.ok) continue; // covered above
      const unknown = [
        ...docTemplateStrings(parsed.doc).flatMap(findUnknownMarketingTags),
        ...findUnknownMarketingTags(s.subject),
      ];
      expect(unknown, `starter "${s.key}" has unknown tags`).toEqual([]);
    }
  });

  it("every starter includes a booking CTA (the whole point)", () => {
    for (const s of STARTER_TEMPLATES) {
      expect(
        s.doc.blocks.some((b) => b.type === "bookingCta"),
        `starter "${s.key}" has no bookingCta`,
      ).toBe(true);
    }
  });
});
