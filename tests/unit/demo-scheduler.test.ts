import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// demo-scheduler.md PR 1 — the demo CTA is flag-gated. These lock the two
// invariants that keep the follow-up embed PR from silently changing today's
// behaviour: with the flag off the CTA is byte-identical to the old link-out,
// and with it on the CTA points at the internal /demo page. The flag is read
// at module-eval, so each case resets modules + re-imports under a stubbed env.

describe("demo scheduler CTA gating", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("flag off (unset) is a true no-op: CTA equals the raw link-out", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_EMBED_ENABLED", "");
    const site = await import("@/lib/marketing/site");

    expect(site.DEMO_EMBED_ENABLED).toBe(false);
    expect(site.DEMO_CTA_HREF).toBe(site.DEMO_HREF);
    expect(site.DEMO_CTA_EXTERNAL).toBe(site.DEMO_IS_EXTERNAL);
  });

  it("only '1' enables the embed — other truthy-ish values stay off", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_EMBED_ENABLED", "true");
    const site = await import("@/lib/marketing/site");

    expect(site.DEMO_EMBED_ENABLED).toBe(false);
    expect(site.DEMO_CTA_HREF).toBe(site.DEMO_HREF);
  });

  it("flag on ('1') routes the CTA to the internal /demo page", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_EMBED_ENABLED", "1");
    const site = await import("@/lib/marketing/site");

    expect(site.DEMO_EMBED_ENABLED).toBe(true);
    expect(site.DEMO_CTA_HREF).toBe(site.DEMO_PAGE_HREF);
    expect(site.DEMO_CTA_HREF).toBe("/demo");
    // Internal route → never treated as an off-site link.
    expect(site.DEMO_CTA_EXTERNAL).toBe(false);
  });
});
