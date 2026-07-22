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

    // The floor plan is a canvas of table shapes, each exposed as
    // role="button" labelled "Table <label>, <state>" (table-shape.tsx).
    // The café template seeds six, T1–T6.
    const tableShapes = page.getByRole("button", { name: /^Table T[0-9]+, / });
    await expect(page.getByRole("button", { name: /^Table T1, / })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Table T6, / })).toBeVisible();
    expect(await tableShapes.count()).toBeGreaterThanOrEqual(6);

    // The template's single area ("Inside") is asserted through its tables:
    // the canvas only renders the area switcher for venues with more than
    // one area (canvas.tsx), so a one-area venue never shows its name.

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
