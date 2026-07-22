// End-to-end smoke for the bookings phase.
//
// Seeds a confirmed user + org + venue (via admin API / SQL, same
// pattern as venues.spec.ts), then drives the dashboard UI to:
//   1. navigate to the Bookings tab
//   2. create a booking via /bookings/new (date, party, slot, guest)
//   3. see the row on today's list and mark it seated → finished

import { Pool } from "pg";
import { expect, test } from "@playwright/test";

import { bookingDay } from "./support/booking-date";
import {
  cleanupOwner,
  loginAsOwner,
  ownerSeedConfigured,
  seedOwnerWithTotp,
  type SeededOwner,
} from "./support/owner-session";

const DATABASE_URL = process.env["DATABASE_URL"];

// Computed, not fixed: the old constant had drifted five weeks into the past,
// so the slot grid had nothing to offer and the "12:00" click timed out.
const DATE = bookingDay().iso;

test.describe.configure({ mode: "serial" });

test.describe("bookings flow", () => {
  const runId = Date.now().toString(36);
  const venueName = `E2E Venue ${runId}`;

  let owner: SeededOwner | null = null;
  let venueId: string | null = null;

  test.beforeAll(async () => {
    test.skip(!ownerSeedConfigured(), "Supabase/DB env not set");

    owner = await seedOwnerWithTotp({
      label: "bookings",
      runId,
      orgName: `E2E Bookings Org ${runId}`,
    });
    const orgId = owner.orgId;

    // Exactly one venue, so the dashboard's single-venue redirect is the
    // state this spec exercises.
    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
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
    if (owner) await cleanupOwner(owner);
  });

  test("host creates a booking, sees it on the day list, seats + finishes it", async ({ page }) => {
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));

    // --- log in ----------------------------------------------------
    // Password sign-in plus the owner MFA challenge; see the helper.
    await loginAsOwner(page, owner!);

    // Single-venue org → straight to that venue's bookings list; see the
    // single-venue branch in app/(dashboard)/dashboard/page.tsx.
    await page.waitForURL(/\/dashboard\/venues\/[0-9a-f-]+\/bookings$/, { timeout: 15_000 });

    // --- open the new-booking form --------------------------------
    await page.getByRole("link", { name: /New booking/ }).click();
    await page.waitForURL(/\/dashboard\/venues\/[0-9a-f-]+\/bookings\/new/, { timeout: 10_000 });

    // Choose our fixed future date + party size 2.
    await page.getByLabel("Date").fill(DATE);
    await page.getByLabel("Party size").fill("2");

    // Pick a slot time — the grid renders buttons labelled "HH:MM". Take the
    // first the service offers rather than naming one: the seeded service runs
    // 08:00–17:00 on 45-minute turns, which doesn't put a slot on 12:00.
    await page
      .getByRole("button", { name: /^[0-9]{2}:[0-9]{2}$/ })
      .first()
      .click();

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
