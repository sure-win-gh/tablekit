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

import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const SUPABASE_URL = process.env["NEXT_PUBLIC_SUPABASE_URL"];
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const DATABASE_URL = process.env["DATABASE_URL"];

test.describe.configure({ mode: "serial" });

test.describe("auth flow", () => {
  const runId = Date.now().toString(36);
  const email = `e2e-login-${runId}@tablekit.test`;
  const password = "e2e-test-password-1234";
  const fullName = `E2E User ${runId}`;
  const orgName = `E2E Test ${runId}`;
  const orgSlug = `e2e-test-${runId}`;

  let userId: string | null = null;

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
    if (error || !data.user) {
      throw error ?? new Error("createUser failed");
    }
    userId = data.user.id;

    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
      const inserted = await pool.query<{ id: string }>(
        "insert into organisations (name, slug) values ($1, $2) returning id",
        [orgName, orgSlug],
      );
      const orgId = inserted.rows[0]?.id;
      if (!orgId) throw new Error("org insert returned no row");
      await pool.query(
        "insert into memberships (user_id, organisation_id, role) values ($1, $2, 'owner')",
        [userId, orgId],
      );
    } finally {
      await pool.end();
    }
  });

  test.afterAll(async () => {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !userId) return;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await admin.auth.admin.deleteUser(userId).catch(() => undefined);

    if (DATABASE_URL) {
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        await pool.query("delete from organisations where slug = $1", [orgSlug]);
      } finally {
        await pool.end();
      }
    }
  });

  test("login + dashboard + sign out", async ({ page }) => {
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));

    // --- login ---------------------------------------------------------
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL("**/dashboard", { timeout: 15_000 });

    // --- dashboard ----------------------------------------------------
    // h1 is the active org name; header shows full_name (dashboard
    // prefers fullName over email).
    await expect(page.getByRole("heading", { name: orgName })).toBeVisible();
    await expect(page.getByText(fullName)).toBeVisible();

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
