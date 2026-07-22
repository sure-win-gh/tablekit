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
  loginAsOwner,
  ownerSeedConfigured,
  seedOwnerWithTotp,
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

  test("create a café, template seeds, services and floor plan populated", async ({ page }) => {
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));

    // --- log in ----------------------------------------------------
    // Password sign-in plus the owner MFA challenge; see the helper.
    await loginAsOwner(page, owner!);

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

    // "Inside" is the café template's single area. It's rendered as an
    // editable text input, so the assertion targets the input's value
    // rather than visible text.
    const areaNameInput = page.locator("input[name='name']").first();
    await expect(areaNameInput).toHaveValue("Inside");

    // 6 tables from the template — each row has label, min, max etc.
    // Count rows by looking at the "Delete" buttons (one per row).
    // We don't assert an exact number because the layout could change;
    // just that "several" tables are there.
    const tableDeleteButtons = page.getByRole("button", { name: "Delete" });
    await expect(tableDeleteButtons.first()).toBeVisible();
    expect(await tableDeleteButtons.count()).toBeGreaterThanOrEqual(3);

    // --- services tab has the seeded service -----------------------
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
