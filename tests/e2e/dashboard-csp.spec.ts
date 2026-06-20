// E2E: the dashboard ships a nonce-based CSP and Next.js stamps that exact
// nonce onto its framework scripts. This is the load-bearing check for
// proxy.ts — that setting the CSP on the request headers actually makes Next
// nonce its scripts (so a future enforce flip won't break hydration).
//
// Seeds + logs in via the Supabase admin API, mirroring auth.spec.ts.

import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const SUPABASE_URL = process.env["NEXT_PUBLIC_SUPABASE_URL"];
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const DATABASE_URL = process.env["DATABASE_URL"];

test.describe.configure({ mode: "serial" });

test.describe("dashboard CSP", () => {
  const runId = Date.now().toString(36);
  const email = `e2e-csp-${runId}@tablekit.test`;
  const password = "e2e-test-password-1234";
  const orgName = `E2E CSP ${runId}`;
  const orgSlug = `e2e-csp-${runId}`;

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
      user_metadata: { full_name: `E2E CSP ${runId}` },
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

  test("serves a nonce CSP and Next stamps the same nonce on its scripts", async ({ page }) => {
    // Generous timeout: the first authenticated /dashboard nav may hit a cold
    // Turbopack dev compile (no reliance on another spec having warmed it).
    test.setTimeout(120_000);
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/dashboard", { timeout: 90_000 });

    // Re-navigate to capture the document response + headers.
    const resp = await page.goto("/dashboard");
    expect(resp).not.toBeNull();

    // Exactly one CSP header (Report-Only by default — CSP_DASHBOARD_ENFORCE
    // unset in CI), so a duplicate/dropped-header regression is caught.
    const cspHeaders = (await resp!.headersArray()).filter(
      (h) => h.name.toLowerCase() === "content-security-policy-report-only",
    );
    expect(cspHeaders).toHaveLength(1);
    const csp = cspHeaders[0]!.value;
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    // No enforcing header while in Report-Only mode.
    expect(resp!.headers()["content-security-policy"]).toBeUndefined();

    // The nonce in the header must also appear on Next's scripts in the HTML —
    // this proves the request-header nonce reached Next's renderer.
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    const html = await resp!.text();
    expect(html).toContain(`nonce="${nonce}"`);
  });
});
