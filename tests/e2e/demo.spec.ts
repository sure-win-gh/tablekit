import { expect, test } from "@playwright/test";

// /demo consent-gated Cal.com scheduler (docs/specs/demo-scheduler.md).
//
// The privacy contract is: no Cal.com script / iframe / cookie loads until the
// visitor explicitly clicks "Load scheduler". The embed only renders when
// NEXT_PUBLIC_DEMO_EMBED_ENABLED is on, so the gated test skips (and /demo is a
// plain link-out) otherwise — the flag is off by default until go-live.

const EMBED_ON = process.env["NEXT_PUBLIC_DEMO_EMBED_ENABLED"] === "1";

test("demo page renders the hero", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test.describe("consent-gated Cal.com embed", () => {
  test.skip(!EMBED_ON, "NEXT_PUBLIC_DEMO_EMBED_ENABLED not set — /demo is link-out only");

  test("loads no Cal.com resource until the visitor clicks Load scheduler", async ({ page }) => {
    // Stay hermetic: never actually hit Cal.com. Record every attempt and
    // fulfil it with an empty stub so the click path doesn't depend on the
    // network (or leak a real third-party request from CI).
    const calRequests: string[] = [];
    // EU region (cal.eu) — see lib/marketing/site.ts / the /demo CSP.
    await page.route(/https:\/\/(app\.)?cal\.eu\//, (route) => {
      calRequests.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    });

    await page.goto("/demo");

    // The consent gate is shown and the embed is NOT loaded.
    const loadBtn = page.getByRole("button", { name: /load scheduler/i });
    await expect(loadBtn).toBeVisible();
    // The no-consent fallback link is always present.
    await expect(page.getByRole("link", { name: /without loading the embed/i })).toBeVisible();
    // Nothing third-party requested before consent — the load-bearing assertion.
    expect(calRequests, "no Cal.com request before click").toHaveLength(0);

    await loadBtn.click();

    // After consent the embed chunk mounts and reaches for Cal.com…
    await expect.poll(() => calRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);
    // …and the gate is gone.
    await expect(loadBtn).toBeHidden();
  });
});
