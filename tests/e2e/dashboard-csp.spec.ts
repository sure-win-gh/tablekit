// E2E: the dashboard ships a nonce-based CSP and Next.js stamps that exact
// nonce onto its framework scripts. This is the load-bearing check for
// proxy.ts — that setting the CSP on the request headers actually makes Next
// nonce its scripts (so a future enforce flip won't break hydration).
//
// Seeds + logs in via the Supabase admin API, mirroring auth.spec.ts.

import { expect, test } from "@playwright/test";

import {
  cleanupOwner,
  ownerSeedConfigured,
  seedOwnerWithTotp,
  startAuthenticated,
  type SeededOwner,
} from "./support/owner-session";

test.describe.configure({ mode: "serial" });

test.describe("dashboard CSP", () => {
  const runId = Date.now().toString(36);

  let owner: SeededOwner | null = null;

  test.beforeAll(async () => {
    test.skip(!ownerSeedConfigured(), "Supabase/DB env not set");
    owner = await seedOwnerWithTotp({ label: "csp", runId, orgName: `E2E CSP ${runId}` });
  });

  test.afterAll(async () => {
    if (owner) await cleanupOwner(owner);
  });

  test("serves a nonce CSP and Next stamps the same nonce on its scripts", async ({
    page,
    context,
  }) => {
    // Session established programmatically; this spec is about response
    // headers, not the login UI, and the login rate limit is auth.spec's to
    // spend. See the helper.
    await startAuthenticated(context, owner!);

    // Navigate to capture the document response + headers.
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
