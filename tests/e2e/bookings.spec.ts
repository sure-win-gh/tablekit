// End-to-end smoke for the bookings phase.
//
// Seeds a confirmed user + org + venue (via admin API / SQL, same
// pattern as venues.spec.ts), then drives the dashboard UI to:
//   1. navigate to the Bookings tab
//   2. create a booking via /bookings/new (date, party, slot, guest)
//   3. see the row on today's list and mark it seated → finished

import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const SUPABASE_URL = process.env["NEXT_PUBLIC_SUPABASE_URL"];
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const DATABASE_URL = process.env["DATABASE_URL"];

// Pick a date far enough ahead that it won't drift into "yesterday"
// overnight — same approach as the integration test.
const DATE = "2026-06-15"; // Monday, BST

test.describe.configure({ mode: "serial" });

test.describe("bookings flow", () => {
  const runId = Date.now().toString(36);
  const email = `e2e-bookings-${runId}@tablekit.test`;
  const password = "e2e-test-password-1234";
  const fullName = `E2E Bookings ${runId}`;
  const orgName = `E2E Bookings Org ${runId}`;
  const orgSlug = `e2e-bookings-${runId}`;
  const venueName = `E2E Venue ${runId}`;

  let userId: string | null = null;
  let orgId: string | null = null;
  let venueId: string | null = null;

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
      const { rows: orgRows } = await pool.query<{ id: string }>(
        "insert into organisations (name, slug) values ($1, $2) returning id",
        [orgName, orgSlug],
      );
      orgId = orgRows[0]!.id;
      await pool.query(
        "insert into memberships (user_id, organisation_id, role) values ($1, $2, 'owner')",
        [userId, orgId],
      );
      const { rows: venueRows } = await pool.query<{ id: string }>(
        "insert into venues (organisation_id, name, venue_type, timezone) values ($1, $2, 'cafe', 'Europe/London') returning id",
        [orgId, venueName],
      );
      venueId = venueRows[0]!.id;
      const { rows: areaRows } = await pool.query<{ id: string }>(
        "insert into areas (organisation_id, venue_id, name) values ($1, $2, 'Inside') returning id",
        [orgId, venueId],
      );
      const areaId = areaRows[0]!.id;
      await pool.query(
        "insert into tables (organisation_id, venue_id, area_id, label, max_cover) values ($1, $2, $3, 'T1', 4)",
        [orgId, venueId, areaId],
      );
      await pool.query(
        `insert into services (organisation_id, venue_id, name, schedule, turn_minutes)
         values ($1, $2, 'Open',
                 '{"days":["sun","mon","tue","wed","thu","fri","sat"],"start":"08:00","end":"17:00"}'::jsonb,
                 45)`,
        [orgId, venueId],
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
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        await pool.query("delete from organisations where id = $1", [orgId]);
      } finally {
        await pool.end();
      }
    }
  });

  test("host creates a booking, sees it on the day list, seats + finishes it", async ({ page }) => {
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));

    // --- log in ----------------------------------------------------
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // Single-venue org → straight to the venue's floor plan.
    await page.waitForURL(/\/dashboard\/venues\/[0-9a-f-]+\/floor-plan/, { timeout: 15_000 });

    // --- navigate to bookings -------------------------------------
    await page.getByRole("link", { name: "Bookings" }).click();
    await page.waitForURL(/\/dashboard\/venues\/[0-9a-f-]+\/bookings$/, { timeout: 10_000 });

    // --- open the new-booking form --------------------------------
    await page.getByRole("link", { name: /New booking/ }).click();
    await page.waitForURL(/\/dashboard\/venues\/[0-9a-f-]+\/bookings\/new/, { timeout: 10_000 });

    // Choose our fixed future date + party size 2.
    await page.getByLabel("Date").fill(DATE);
    await page.getByLabel("Party size").fill("2");

    // Pick a slot time — the grid renders buttons labelled "HH:MM".
    await page.getByRole("button", { name: "12:00", exact: true }).click();

    // Guest form — fill and submit.
    await page.getByLabel("First name").fill("Alice");
    await page.getByLabel("Last name").fill("Tester");
    await page.getByLabel("Email").fill(`alice-${runId}@example.com`);
    await page.getByRole("button", { name: "Create booking" }).click();

    // Should land back on /bookings?date=DATE with the row visible.
    await page.waitForURL(new RegExp(`/bookings\\?date=${DATE}`), { timeout: 10_000 });

    // The row shows "Alice · party of 2" alongside the 12:00–12:45 time.
    const row = page.locator("li", { hasText: "Alice · party of 2" });
    await expect(row).toBeVisible();

    // --- seat → finish -------------------------------------------
    await row.getByRole("button", { name: "Seat" }).click();
    // After revalidatePath, the row re-renders with a Seated chip +
    // a "Finish" button. Wait for the finish button before clicking.
    await expect(row.getByRole("button", { name: "Finish" })).toBeVisible();
    await row.getByRole("button", { name: "Finish" }).click();

    // Final state: row still on the list, chip reads "Finished".
    await expect(row).toContainText("Finished");
  });
});
