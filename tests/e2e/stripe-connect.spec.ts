// E2E smoke for payments-connect.
//
// Logs a manager in, navigates to venue settings, clicks "Connect
// Stripe", asserts the browser hops out to a Stripe-hosted URL.
//
// We deliberately don't try to complete the onboarding flow — that
// needs interactive KYC against Stripe's test environment and isn't
// a reliable CI target. Getting to connect.stripe.com proves the
// server action + Stripe API integration works.
//
// Skips cleanly if STRIPE_SECRET_KEY is a placeholder.

import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const SUPABASE_URL = process.env["NEXT_PUBLIC_SUPABASE_URL"];
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const DATABASE_URL = process.env["DATABASE_URL"];
const STRIPE_KEY = process.env["STRIPE_SECRET_KEY"];

function stripeConfigured(): boolean {
  if (!STRIPE_KEY) return false;
  if (STRIPE_KEY.includes("YOUR_")) return false;
  return STRIPE_KEY.startsWith("sk_test_") || STRIPE_KEY.startsWith("sk_live_");
}

test.describe.configure({ mode: "serial" });

test.describe("stripe connect onboarding", () => {
  const runId = Date.now().toString(36);
  const email = `e2e-stripe-${runId}@tablekit.test`;
  const password = "e2e-test-password-1234";
  const fullName = `E2E Stripe ${runId}`;
  const orgName = `E2E Stripe Org ${runId}`;
  const orgSlug = `e2e-stripe-${runId}`;
  const venueName = `E2E Stripe Venue ${runId}`;

  let userId: string | null = null;
  let orgId: string | null = null;

  test.beforeAll(async () => {
    test.skip(!SUPABASE_URL || !SERVICE_ROLE_KEY || !DATABASE_URL, "Supabase/DB env not set");
    test.skip(!stripeConfigured(), "STRIPE_SECRET_KEY not configured (placeholder)");

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
        "insert into memberships (user_id, organisation_id, role) values ($1, $2, 'manager')",
        [userId, orgId],
      );
      await pool.query(
        "insert into venues (organisation_id, name, venue_type) values ($1, $2, 'cafe')",
        [orgId, venueName],
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

  test("manager can start Stripe Connect onboarding and hop out to Stripe", async ({ page }) => {
    page.on("pageerror", (err) => console.error("[pageerror]", err.message));

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // Single-venue org → redirected to the venue's floor plan.
    await page.waitForURL(/\/dashboard\/venues\/[0-9a-f-]+\/floor-plan/, { timeout: 15_000 });

    // Settings tab → billing section → Connect.
    await page.getByRole("link", { name: "Settings" }).click();
    await page.waitForURL(/\/dashboard\/venues\/[0-9a-f-]+\/settings/, { timeout: 10_000 });

    await expect(page.getByRole("heading", { name: "Payments" })).toBeVisible();

    // Capture the navigation triggered by the Connect button — we
    // expect it to land on connect.stripe.com.
    const navPromise = page.waitForURL(/connect\.stripe\.com/, { timeout: 20_000 });
    await page.getByRole("button", { name: /Connect Stripe/ }).click();
    await navPromise;

    expect(page.url()).toContain("connect.stripe.com");
  });
});
