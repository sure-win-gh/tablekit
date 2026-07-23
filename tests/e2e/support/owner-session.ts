// Seeds an owner that can actually reach the dashboard, and logs it in.
//
// The dashboard layout renders app/(dashboard)/mfa-wall.tsx over everything
// until an owner or manager has a verified TOTP factor — "TOTP for owners" in
// CLAUDE.md. Specs that seed an owner and log in therefore land on the wall
// rather than the page under test, and no amount of data setup gets past it.
//
// So we enrol for real, through the same public API an operator's browser
// uses: sign in with the password, then mfa.enroll -> mfa.challenge ->
// mfa.verify with a code generated from the returned secret. No app code is
// touched and the gate is not weakened — the seeded owner simply satisfies it.
// After enrolment the factor is verified, but each fresh browser login starts
// at aal1, so loginAsOwner completes the wall's challenge step in the UI.
//
// Lives under tests/e2e/ rather than tests/support/ because .claude/hooks/
// guard-pii.js only exempts the test suites from its service_role rule, and
// widening a security guard is not this change's business.
//
// Every spec gets its own user and org, so nothing here assumes an empty
// database.

import { createHmac } from "node:crypto";

import type { BrowserContext, Cookie, Page } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { generateSync } from "otplib";
import { Pool } from "pg";

import { installBadJwtRetry } from "../../support/bad-jwt-retry";

const SUPABASE_URL = process.env["NEXT_PUBLIC_SUPABASE_URL"];
const ANON_KEY = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const ADMIN_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const DATABASE_URL = process.env["DATABASE_URL"];
const APP_BASE_URL = process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:3000";

export const OWNER_PASSWORD = "e2e-test-password-1234";
const TOTP_STEP_SECONDS = 30;

export type SeededOwner = {
  userId: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  email: string;
  password: string;
  fullName: string;
  totpSecret: string;
  /** The code already spent; never replayed (see freshTotpCode). */
  lastCode: string;
  /** aal2 session cookies, ready for BrowserContext.addCookies. */
  sessionCookies: Cookie[];
};

/** True when every secret the owner helpers need is present. */
export function ownerSeedConfigured(): boolean {
  return Boolean(SUPABASE_URL && ANON_KEY && ADMIN_KEY && DATABASE_URL);
}

function adminClient() {
  return createClient(SUPABASE_URL!, ADMIN_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type SetCookie = { name: string; value: string; options?: Record<string, unknown> };

/**
 * Minimal cookie store for the @supabase/ssr server client: it reads back
 * what it wrote (so the MFA calls see the session from sign-in) and keeps the
 * final state for handing to a browser context.
 */
class CookieJar {
  private readonly store = new Map<string, SetCookie>();

  getAll(): { name: string; value: string }[] {
    return [...this.store.values()].map(({ name, value }) => ({ name, value }));
  }

  setAll(list: SetCookie[]): void {
    for (const cookie of list) {
      // An empty value is the library expiring a chunk; drop it rather than
      // handing the browser a cookie that unsets the session.
      if (cookie.value === "") this.store.delete(cookie.name);
      else this.store.set(cookie.name, cookie);
    }
  }

  toPlaywrightCookies(): Cookie[] {
    return [...this.store.values()].map(({ name, value, options }) => {
      const sameSite = String(options?.["sameSite"] ?? "lax").toLowerCase();
      return {
        name,
        value,
        domain: new URL(APP_BASE_URL).hostname,
        path: String(options?.["path"] ?? "/"),
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: sameSite === "strict" ? "Strict" : sameSite === "none" ? "None" : "Lax",
      } satisfies Cookie;
    });
  }
}

/**
 * A TOTP code that differs from `previous`. Supabase rejects a code that has
 * already been spent, so when the window hasn't rolled over we wait it out
 * instead of submitting a duplicate.
 */
export async function freshTotpCode(secret: string, previous?: string): Promise<string> {
  let code = generateSync({ secret });
  if (previous && code === previous) {
    // otplib 13 dropped timeRemaining(); TOTP's default step is 30s.
    const secondsLeft = TOTP_STEP_SECONDS - (Math.floor(Date.now() / 1000) % TOTP_STEP_SECONDS);
    await new Promise((resolve) => setTimeout(resolve, (secondsLeft + 1) * 1000));
    code = generateSync({ secret });
  }
  return code;
}

/**
 * Create a confirmed user, an organisation, an owner membership, and a
 * verified TOTP factor. `label` keeps emails and slugs distinct per spec.
 */
export async function seedOwnerWithTotp(opts: {
  label: string;
  runId: string;
  orgName?: string;
}): Promise<SeededOwner> {
  installBadJwtRetry();

  const { label, runId } = opts;
  const email = `e2e-${label}-${runId}@tablekit.test`;
  const fullName = `E2E ${label} ${runId}`;
  const orgName = opts.orgName ?? `E2E ${label} Org ${runId}`;
  const orgSlug = `e2e-${label}-${runId}`;

  const admin = adminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: OWNER_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error || !data.user) throw error ?? new Error("seedOwnerWithTotp: createUser failed");
  const userId = data.user.id;

  const pool = new Pool({ connectionString: DATABASE_URL });
  let orgId: string;
  try {
    const inserted = await pool.query<{ id: string }>(
      "insert into organisations (name, slug) values ($1, $2) returning id",
      [orgName, orgSlug],
    );
    const org = inserted.rows[0];
    if (!org) throw new Error("seedOwnerWithTotp: org insert returned no row");
    orgId = org.id;
    await pool.query(
      "insert into memberships (user_id, organisation_id, role) values ($1, $2, 'owner')",
      [userId, orgId],
    );
  } finally {
    await pool.end();
  }

  // Enrol through the user's own session — the same calls the browser makes —
  // but drive it with @supabase/ssr's server client over a capturing cookie
  // jar. That way the session cookies are produced by the library itself, in
  // exactly the name, encoding and chunking the app reads back, rather than
  // being hand-encoded here.
  const jar = new CookieJar();
  const user = createServerClient(SUPABASE_URL!, ANON_KEY!, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (list) => jar.setAll(list),
    },
  });

  const signIn = await user.auth.signInWithPassword({ email, password: OWNER_PASSWORD });
  if (signIn.error) throw signIn.error;

  const enrolled = await user.auth.mfa.enroll({ factorType: "totp" });
  if (enrolled.error) throw enrolled.error;
  const factorId = enrolled.data.id;
  const totpSecret = enrolled.data.totp.secret;

  const challenge = await user.auth.mfa.challenge({ factorId });
  if (challenge.error) throw challenge.error;

  const lastCode = generateSync({ secret: totpSecret });
  const verified = await user.auth.mfa.verify({
    factorId,
    challengeId: challenge.data.id,
    code: lastCode,
  });
  if (verified.error) throw verified.error;

  // Verifying upgrades the session to aal2, so the cookies now in the jar
  // satisfy the MFA wall as well as the auth check. Deliberately no signOut:
  // that would clear the very cookies we want to hand to the browser.
  const sessionCookies = jar.toPlaywrightCookies();

  return {
    userId,
    orgId,
    orgName,
    orgSlug,
    email,
    password: OWNER_PASSWORD,
    fullName,
    totpSecret,
    lastCode,
    sessionCookies,
  };
}

/**
 * Start the browser already signed in, without touching /login.
 *
 * The login server action rate-limits to 5 attempts per IP per 15 minutes
 * (app/(marketing)/login/actions.ts, per docs/playbooks/security.md). Every
 * spec in CI shares one runner IP, and with retries a full run blew straight
 * through that budget — the trace for run 29992404446 shows "Too many
 * attempts" on the login page. The limiter is correct and stays untouched;
 * the specs simply stop spending attempts on setup they aren't testing.
 *
 * The cookies come from @supabase/ssr itself during seeding, so this is the
 * same session the app would have minted — including aal2, so the MFA wall is
 * satisfied. auth.spec.ts deliberately does not use this: driving the real
 * login and challenge UI is the surface it exists to cover, and one UI login
 * per run sits well inside the limit.
 */
export async function startAuthenticated(context: BrowserContext, owner: SeededOwner) {
  await context.addCookies([...owner.sessionCookies, activeOrgCookie(owner.orgId)]);
}

/**
 * The dashboard also needs an active organisation — the login action sets an
 * HMAC-signed tk_active_org cookie, and without it /dashboard bounces to
 * /login?error=no_active_org. Mint it the same way setActiveOrg does
 * (lib/auth/active-org.ts) using the secret the test env already holds.
 */
function activeOrgCookie(orgId: string): Cookie {
  const secret = process.env["SESSION_SIGNING_SECRET"];
  if (!secret) throw new Error("startAuthenticated: SESSION_SIGNING_SECRET is not set");
  const sig = createHmac("sha256", secret).update(orgId).digest("base64url");

  return {
    name: "tk_active_org",
    value: `${orgId}.${sig}`,
    domain: new URL(APP_BASE_URL).hostname,
    path: "/",
    expires: -1,
    // Mirrors setActiveOrg: httpOnly, and only secure over HTTPS.
    httpOnly: true,
    secure: APP_BASE_URL.startsWith("https://"),
    sameSite: "Lax",
  };
}

/**
 * Log the seeded owner in through the real UI and clear the MFA challenge.
 * Returns once the wall is gone; callers assert on whatever page they expect.
 */
export async function loginAsOwner(page: Page, owner: SeededOwner): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // A fresh browser session is aal1, so the wall asks for a code.
  const codeField = page.getByLabel("6-digit code");
  await codeField.waitFor({ state: "visible", timeout: 15_000 });

  const code = await freshTotpCode(owner.totpSecret, owner.lastCode);
  owner.lastCode = code;
  await codeField.fill(code);
  await page.getByRole("button", { name: "Verify" }).click();

  // The wall reloads the current path once the factor is satisfied.
  await codeField.waitFor({ state: "detached", timeout: 15_000 });
}

/** Best-effort teardown so the shared CI database doesn't accumulate junk. */
export async function cleanupOwner(owner: Pick<SeededOwner, "userId" | "orgSlug">): Promise<void> {
  try {
    if (SUPABASE_URL && ADMIN_KEY) {
      await adminClient()
        .auth.admin.deleteUser(owner.userId)
        .catch(() => undefined);
    }
    if (DATABASE_URL) {
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        await pool.query("delete from organisations where slug = $1", [owner.orgSlug]);
      } finally {
        await pool.end();
      }
    }
  } catch {
    // Teardown must never fail a spec.
  }
}
