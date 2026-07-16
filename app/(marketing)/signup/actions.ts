"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { makeOrgSlug } from "@/lib/auth/slug";
import { setActiveOrg } from "@/lib/auth/active-org";
import { supabaseServer } from "@/lib/db/supabase-server";
import { memberships, organisations } from "@/lib/db/schema";
import { captureMessage } from "@/lib/observability/capture";
import { ipFromHeaders, rateLimit } from "@/lib/public/rate-limit";
import { regionEnabled } from "@/lib/regions/config";
import {
  DEFAULT_SIGNUP_COUNTRY,
  regionForCountry,
  resolveSignupRegion,
} from "@/lib/regions/mapping";
import { adminDb } from "@/lib/server/admin/db";
import { audit } from "@/lib/server/admin/audit";

import { parseSignupForm } from "./parse";

// Stop mass account creation from a single source: 5 signups per IP
// per 15 minutes (matches the auth-surface limit in security.md).
const SIGNUP_ATTEMPTS = 5;
const SIGNUP_WINDOW_SEC = 15 * 60;

export type SignupState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> }
  | { status: "needs_confirm"; email: string };

export async function signUp(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const parsed = parseSignupForm(formData);

  if (!parsed.ok) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: parsed.fieldErrors,
    };
  }

  const { email, password, fullName, orgName } = parsed.data;
  const country = parsed.data.country ?? DEFAULT_SIGNUP_COUNTRY;

  // Country → {region, entity}, clamped by the US launch gate. The form
  // hides the US option until regionEnabled("us"); this is the server-side
  // enforcement so a stale/tampered post can never create a US-region org
  // while the gate is closed (fail closed to EU/UK).
  const usEnabled = regionEnabled("us");
  const { region, entity } = resolveSignupRegion(country, usEnabled);
  if (regionForCountry(country).region === "us" && !usEnabled) {
    captureMessage(
      "signup: US region requested while US is not enabled — clamped to eu/uk",
      "warning",
    );
  }

  const ip = ipFromHeaders(await headers());
  const ipLimit = await rateLimit(`signup:ip:${ip}`, SIGNUP_ATTEMPTS, SIGNUP_WINDOW_SEC, {
    failOpen: false,
  });
  if (!ipLimit.ok) {
    return {
      status: "error",
      message: "Too many sign-up attempts. Please wait a few minutes and try again.",
    };
  }

  const supabase = await supabaseServer();

  // Supabase creates auth.users row; our trigger mirrors to public.users.
  // A confirmation email goes out via Supabase's default SMTP in dev
  // (rate-limited to a handful/hour until a custom SMTP is wired, per
  // D7 of the auth plan).
  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      emailRedirectTo: `${appUrl}/auth/callback?next=/dashboard`,
    },
  });

  if (authError || !authData.user) {
    return {
      status: "error",
      message: authError?.message ?? "Sign up failed. Try again in a moment.",
    };
  }

  const userId = authData.user.id;

  // Create the org + owner membership in the org's own regional database.
  // adminDb(region) bypasses RLS because the user has no membership yet —
  // they can't see their own org until this insert lands. `region` is
  // clamped to 'eu' whenever US is disabled, so this resolves to the EU
  // pool today; once REGION_US_ENABLED flips, a US signup lands in the US
  // project with no change here (D5 — resolve the region before writing).
  //
  // The trigger on auth.users → public.users fires first, so by the time
  // we hit public.memberships the user row exists for its FK.
  const orgSlug = makeOrgSlug(orgName);
  const db = adminDb(region);
  const orgId = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organisations)
      .values({ name: orgName, slug: orgSlug, region, billingEntity: entity })
      .returning({ id: organisations.id });

    if (!org) {
      throw new Error("signup: organisation insert returned no row");
    }

    await tx.insert(memberships).values({
      userId,
      organisationId: org.id,
      role: "owner",
    });

    return org.id;
  });

  // TODO(phase-4, multi-region): audit.log writes via the default (EU) pool.
  // Correct today (region is always 'eu' while US is dark), but once a US org
  // is created in the US pool this FK-references a row that lives in another
  // database → violation AFTER the org txn commits. Route audit to the org's
  // region, or designate audit_log as EU control-plane data. See ROADMAP.md §2.
  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "signup",
    targetType: "user",
    targetId: userId,
    metadata: { orgSlug },
  });

  // If Supabase's "Confirm email" setting is on (default), no session
  // yet — show a "check your email" screen. /auth/callback sets the
  // active-org cookie when the user clicks the link.
  if (!authData.session) {
    return { status: "needs_confirm", email };
  }

  // A live session straight after signup means Supabase's "Confirm email"
  // setting is OFF — a production misconfiguration (sessions granted without
  // verifying the address; see security.md "Auth invariants" + the deploy
  // checklist). Surface it loudly so it's caught, but don't block the user.
  if ((process.env["VERCEL_ENV"] ?? process.env["NODE_ENV"]) === "production") {
    captureMessage(
      "signup: live session without email confirmation — Supabase 'Confirm email' is off",
      "error",
    );
  }

  // Email-confirm off: session is live now, drop them on the dashboard
  // with active org already pinned.
  await setActiveOrg(orgId);
  redirect("/dashboard");
}
