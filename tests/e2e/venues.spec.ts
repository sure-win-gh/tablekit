// End-to-end smoke for the venues phase.
//
// Seeds a confirmed user + empty org, then drives the UI through the
// real /venues/new form and asserts the template seed landed: area
// "Inside" on the floor plan, service "Open" on the services tab.
//
// Same pattern as auth.spec.ts — bypasses the rate-limited signup
// email flow by creating the user via the Supabase admin API.

import { expect, test } from "@playwright/test";

import {
  cleanupOwner,
  ownerSeedConfigured,
  seedOwnerWithTotp,
  startAuthenticated,
  type SeededOwner,
} from "./support/owner-session";

test.describe.configure({ mode: "serial" });

test.describe("venues flow", () => {
  const runId = Date.now().toString(36);
  const venueName = `Test Café ${runId}`;

  let owner: SeededOwner | null = null;

  test.beforeAll(async () => {
    test.skip(!ownerSeedConfigured(), "Supabase/DB env not set");
    // No venues seeded: the zero-venue dashboard is the state under test.
    owner = await seedOwnerWithTotp({
      label: "venues",
      runId,
      orgName: `E2E Venues Org ${runId}`,
    });
  });

  test.afterAll(async () => {
    // Organisation delete cascades through venues → areas/tables/services.
    if (owner) await cleanupOwner(owner);
  });

  test("create a café, template seeds, services and floor plan populated", async ({
    page,
    context,
  }) => {
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));

    // --- start signed in -------------------------------------------
    // Session established programmatically; the login UI is auth.spec's job
    // and its rate limit is not this spec's to spend. See the helper.
    await startAuthenticated(context, owner!);
    await page.goto("/dashboard");

    // Zero-venue dashboard → "Create venue" CTA visible.
    await page.waitForURL("**/dashboard", { timeout: 15_000 });
    await expect(page.getByRole("link", { name: "Create venue" })).toBeVisible();

    // --- create the venue ------------------------------------------
    await page.getByRole("link", { name: "Create venue" }).click();
    await page.waitForURL("**/dashboard/venues/new", { timeout: 10_000 });

    await page.getByLabel("Venue name").fill(venueName);
    // "Café" radio is default-checked, but click it to be explicit.
    await page.getByLabel(/^Café/).check();
    await page.getByRole("button", { name: "Create venue" }).click();

    // --- lands on floor plan, with the seeded area + 6 tables -----
    await page.waitForURL(/\/dashboard\/venues\/[0-9a-f-]+\/floor-plan/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: venueName })).toBeVisible();

    // The floor plan is an SVG canvas; each table is a <g> carrying
    // aria-label "Table <label>, <state>" (table-shape.tsx). Matched by
    // attribute rather than getByRole: Chromium doesn't expose SVG groups
    // as buttons in the accessibility tree, so the role query finds nothing
    // even though the shapes are on screen. The café template seeds six.
    await expect(page.locator('[aria-label^="Table T1,"]')).toBeVisible();
    await expect(page.locator('[aria-label^="Table T6,"]')).toBeVisible();
    expect(await page.locator('[aria-label^="Table T"]').count()).toBeGreaterThanOrEqual(6);

    // The template's single area ("Inside") is asserted through its tables:
    // the canvas only renders the area switcher for venues with more than
    // one area (canvas.tsx), so a one-area venue never shows its name.

    // --- services page has the seeded service ----------------------
    // Services moved under the collapsible "Settings" group in the sidebar
    // (sidebar-shell.tsx), so the link is hidden until the group is opened.
    const settingsGroup = page.getByRole("button", { name: "Settings" });
    if ((await settingsGroup.getAttribute("aria-expanded")) === "false") {
      await settingsGroup.click();
    }
    await page.getByRole("link", { name: "Services" }).click();
    await page.waitForURL(/\/services/, { timeout: 10_000 });

    // Every service renders with a name input defaulting to its name.
    // Café template: one service "Open".
    const serviceNameInput = page
      .locator("form")
      .getByLabel("Name")
      .filter({ has: page.locator("xpath=..") })
      .first();
    await expect(serviceNameInput).toHaveValue("Open");
  });
});
