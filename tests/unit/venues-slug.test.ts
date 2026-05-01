import { describe, expect, it } from "vitest";

import {
  RESERVED_SLUGS,
  SLUG_REGEX,
  looksLikeUuid,
  validateSlug,
} from "@/lib/venues/slug";

describe("validateSlug", () => {
  it("accepts a typical slug", () => {
    expect(validateSlug("jane-cafe")).toEqual({ ok: true, slug: "jane-cafe" });
  });

  it("lowercases input", () => {
    expect(validateSlug("Jane-Cafe")).toEqual({ ok: true, slug: "jane-cafe" });
    expect(validateSlug("THE-DOUGHNUT-PLACE")).toEqual({
      ok: true,
      slug: "the-doughnut-place",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(validateSlug("  jane-cafe  ")).toEqual({
      ok: true,
      slug: "jane-cafe",
    });
  });

  it("accepts digits", () => {
    expect(validateSlug("bbq-1898")).toEqual({ ok: true, slug: "bbq-1898" });
    expect(validateSlug("404")).toEqual({ ok: true, slug: "404" });
  });

  it("rejects too-short input", () => {
    const r = validateSlug("ab");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("format");
  });

  it("rejects too-long input", () => {
    const r = validateSlug("a".repeat(61));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("format");
  });

  it("rejects leading hyphen", () => {
    const r = validateSlug("-jane");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("format");
  });

  it("rejects trailing hyphen", () => {
    const r = validateSlug("jane-");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("format");
  });

  it("rejects consecutive hyphens", () => {
    const r = validateSlug("jane--cafe");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("format");
  });

  it("rejects underscores and other punctuation", () => {
    expect(validateSlug("jane_cafe").ok).toBe(false);
    expect(validateSlug("jane.cafe").ok).toBe(false);
    expect(validateSlug("jane cafe").ok).toBe(false);
    expect(validateSlug("jane+cafe").ok).toBe(false);
  });

  it("rejects reserved names with the right reason", () => {
    for (const reserved of RESERVED_SLUGS) {
      // Some reserved names are too short for the format check; only
      // test ones that pass format to assert the reserved branch.
      if (reserved.length < 3) continue;
      if (!SLUG_REGEX.test(reserved)) continue;
      const r = validateSlug(reserved);
      expect(r.ok, `reserved=${reserved}`).toBe(false);
      if (!r.ok) expect(r.reason).toBe("reserved");
    }
  });

  it("rejects uppercase versions of reserved names too", () => {
    const r = validateSlug("DASHBOARD");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("reserved");
  });
});

describe("looksLikeUuid", () => {
  it("matches a v4 UUID", () => {
    expect(looksLikeUuid("d7b7890a-89e4-4fb1-aaa4-37af0b27b963")).toBe(true);
  });

  it("matches uppercase / mixed case", () => {
    expect(looksLikeUuid("D7B7890A-89E4-4FB1-AAA4-37AF0B27B963")).toBe(true);
  });

  it("rejects slugs", () => {
    expect(looksLikeUuid("jane-cafe")).toBe(false);
    expect(looksLikeUuid("the-doughnut-place")).toBe(false);
  });

  it("rejects malformed UUIDs", () => {
    expect(looksLikeUuid("d7b7890a89e44fb1aaa437af0b27b963")).toBe(false);
    expect(looksLikeUuid("not-a-uuid-at-all")).toBe(false);
    expect(looksLikeUuid("")).toBe(false);
  });
});
