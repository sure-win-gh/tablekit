// End-to-end smoke for the password-reset flow.
//
// Two paths: (1) /forgot-password returns the neutral "check your inbox"
// state; (2) /reset-password?token=… with a valid token sets a new password,
// redirects to /login, and the new password then logs in. We can't read the
// emailed link in CI, so we seed the token row directly via the same SHA-256
// hashing the app uses (the inverse of what the action stores).
//
// Serial — the seeded user/token are shared across the tests.

import { createHash } from "node:crypto";

import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { installBadJwtRetry } from "../support/bad-jwt-retry";

// This spec seeds users through the Supabase admin API, which intermittently
// rejects a valid request with 403 bad_jwt. See the helper.
installBadJwtRetry();

const SUPABASE_URL = process.env["NEXT_PUBLIC_SUPABASE_URL"];
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const DATABASE_URL = process.env["DATABASE_URL"];
const RESEND_KEY = process.env["RESEND_API_KEY"];

// Both paths dispatch a real email through Resend — without a live key the
// action fails with "provider-error" and the flow never reaches the
// reset screen. Same shape as stripeConfigured() in stripe-connect.spec.ts.
function resendConfigured(): boolean {
  if (!RESEND_KEY) return false;
  if (RESEND_KEY.includes("YOUR_")) return false;
  return RESEND_KEY.startsWith("re_");
}

test.describe.configure({ mode: "serial" });

test.describe("password reset", () => {
  const runId = Date.now().toString(36);
  const email = `e2e-pwreset-${runId}@tablekit.test`;
  const oldPassword = "e2e-old-password-1234";
  const newPassword = "e2e-new-password-5678";
  const orgName = `E2E PwReset ${runId}`;
  const orgSlug = `e2e-pwreset-${runId}`;
  const token = `e2e-reset-token-${runId}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");

  let userId: string | null = null;

  test.beforeAll(async () => {
    test.skip(!SUPABASE_URL || !SERVICE_ROLE_KEY || !DATABASE_URL, "Supabase/DB env not set");
    test.skip(
      !resendConfigured(),
      "RESEND_API_KEY not configured (missing or placeholder) — set a live re_… key " +
        "in the CI secrets to enable the password-reset e2e flow",
    );

    const admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: oldPassword,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("createUser failed");
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
      // Seed a live reset token (15 min) keyed by its hash.
      await pool.query(
        "insert into password_reset_tokens (user_id, token_hash, expires_at) values ($1, $2, now() + interval '15 minutes')",
        [userId, tokenHash],
      );
    } finally {
      await pool.end();
    }
  });

  test.afterAll(async () => {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !DATABASE_URL) return;
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
      await pool.query("delete from organisations where slug = $1", [orgSlug]);
    } finally {
      await pool.end();
    }
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  });

  test("forgot-password returns a neutral confirmation", async ({ page }) => {
    await page.goto("/forgot-password");
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("Check your inbox.")).toBeVisible();
  });

  test("reset-password sets a new password and the new password logs in", async ({ page }) => {
    await page.goto(`/reset-password?token=${encodeURIComponent(token)}`);
    await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
    await page.getByLabel("New password").fill(newPassword);
    await page.getByRole("button", { name: "Set new password" }).click();

    // Redirected to /login with the success banner.
    await page.waitForURL("**/login**", { timeout: 15_000 });
    await expect(page.getByText("Password updated.")).toBeVisible();

    // The new password now signs in.
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(newPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/dashboard", { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: orgName })).toBeVisible();
  });
});
