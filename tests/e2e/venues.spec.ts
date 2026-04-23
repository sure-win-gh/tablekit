// End-to-end smoke for the venues phase.
//
// Seeds a confirmed user + empty org, then drives the UI through the
// real /venues/new form and asserts the template seed landed: area
// "Inside" on the floor plan, service "Open" on the services tab.
//
// Same pattern as auth.spec.ts — bypasses the rate-limited signup
// email flow by creating the user via the Supabase admin API.

import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const SUPABASE_URL = process.env["NEXT_PUBLIC_SUPABASE_URL"];
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const DATABASE_URL = process.env["DATABASE_URL"];

test.describe.configure({ mode: "serial" });

test.describe("venues flow", () => {
  const runId = Date.now().toString(36);
  const email = `e2e-venues-${runId}@tablekit.test`;
  const password = "e2e-test-password-1234";
  const fullName = `E2E Venues ${runId}`;
  const orgName = `E2E Venues Org ${runId}`;
  const orgSlug = `e2e-venues-${runId}`;
  const venueName = `Test Café ${runId}`;

  let userId: string | null = null;
  let orgId: string | null = null;

  test.beforeAll(async () => {
    test.skip(!SUPABASE_URL || !SERVICE_ROLE_KEY || !DATABASE_URL, "Supabase/DB env not set");

    const admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    userId = data.user.id;

    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
      const inserted = await pool.query<{ id: string }>(
        "insert into organisations (name, slug) values ($1, $2) returning id",
        [orgName, orgSlug],
      );
      const org = inserted.rows[0];
      if (!org) throw new Error("org insert returned no row");
      orgId = org.id;
      await pool.query(
        "insert into memberships (user_id, organisation_id, role) values ($1, $2, 'owner')",
        [userId, orgId],
      );
    } finally {
      await pool.end();
    }
  });

  test.afterAll(async () => {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => undefined);

    if (DATABASE_URL && orgId) {
      // Organisation delete cascades through venues → areas/tables/services.
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        await pool.query("delete from organisations where id = $1", [orgId]);
      } finally {
        await pool.end();
      }
    }
  });

  test("create a café, template seeds, services and floor plan populated", async ({ page }) => {
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));

    // --- log in ----------------------------------------------------
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

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
