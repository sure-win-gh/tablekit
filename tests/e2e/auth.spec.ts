// End-to-end smoke for the auth flow.
//
// Drives /login with a pre-seeded confirmed user and asserts we land
// on /dashboard showing the real org name. Pre-seeds via the Supabase
// admin API so we don't go through the real signUp flow (which is
// rate-limited to ~3-4 emails/hour on Supabase's default SMTP and
// blows up on repeat runs).
//
// Serial inside a describe block — the two tests share a logged-in
// context and parallel beforeAll'd createUser calls against the same
// Supabase project race and return "Database error creating new user".
//
// Signup (the UI path) is exercised indirectly by the integration test
// in tests/integration/rls-cross-tenant.test.ts; a full-stack UI
// signup e2e lands when we've wired a programmatic mailbox.

import { expect, test } from "@playwright/test";

import {
  cleanupOwner,
  loginAsOwner,
  ownerSeedConfigured,
  seedOwnerWithTotp,
  type SeededOwner,
} from "./support/owner-session";

test.describe.configure({ mode: "serial" });

test.describe("auth flow", () => {
  const runId = Date.now().toString(36);

  let owner: SeededOwner | null = null;

  test.beforeAll(async () => {
    test.skip(!ownerSeedConfigured(), "Supabase/DB env not set");
    owner = await seedOwnerWithTotp({ label: "login", runId, orgName: `E2E Test ${runId}` });
  });

  test.afterAll(async () => {
    if (owner) await cleanupOwner(owner);
  });

  test("login + dashboard + sign out", async ({ page }) => {
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));

    const seeded = owner!;

    // --- login ---------------------------------------------------------
    // Covers password sign-in plus the owner MFA challenge; see the helper.
    await loginAsOwner(page, seeded);
    await page.waitForURL("**/dashboard", { timeout: 15_000 });

    // --- dashboard ----------------------------------------------------
    // h1 is the active org name; header shows full_name (dashboard
    // prefers fullName over email).
    await expect(page.getByRole("heading", { name: seeded.orgName })).toBeVisible();
    await expect(page.getByText(seeded.fullName)).toBeVisible();

    // --- sign out -----------------------------------------------------
    // Cookies live on the test's browser context, so this completes
    // the loop without a second login.
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/login", { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("middleware redirects unauthenticated /dashboard to /login", async ({ page }) => {
    // Fresh context (new test = new cookies), so we're unauthenticated.
    await page.goto("/dashboard");
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});
