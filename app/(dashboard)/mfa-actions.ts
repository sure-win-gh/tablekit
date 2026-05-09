"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getActiveOrg } from "@/lib/auth/active-org";
import { withUser } from "@/lib/db/client";
import { memberships } from "@/lib/db/schema";
import { supabaseServer } from "@/lib/db/supabase-server";
import { audit } from "@/lib/server/admin/audit";

// Server actions for the TOTP enrolment + challenge + disable flows.
// All three live alongside the dashboard layout's MfaWall so the gate
// experience is self-contained: enrol from inside the wall when a
// new owner/manager first lands; challenge from the wall on every
// fresh session for users with an existing factor; disable from the
// settings page after the user has already passed the gate (AAL2).

const VerifyInput = z.object({
  factorId: z.string().uuid(),
  // 6-digit TOTP codes are the common case; some authenticator apps
  // emit 8 digits for legacy reasons. Accept both, strip whitespace.
  code: z.string().regex(/^\d{6,8}$/),
});

const DisableInput = z.object({ factorId: z.string().uuid() });

export type EnrolResult =
  | { ok: true; factorId: string; qrCodeSvg: string; secret: string }
  | { ok: false; message: string };

export type VerifyResult = { ok: true } | { ok: false; message: string };

// Begin TOTP enrolment. Supabase generates a secret + QR code; we
// hand both to the client so the user can scan or hand-enter into
// their authenticator app. Idempotent-ish: Supabase happily creates
// a fresh unverified factor on every call. The `friendlyName` lets
// the user identify the factor in `auth.mfa_factors` later.
export async function enrolTotp(): Promise<EnrolResult> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "not signed in" };

  // List existing factors first. If the user has an UNVERIFIED factor
  // hanging around (interrupted enrolment), unenrol it before creating
  // a fresh one — otherwise Supabase accumulates dead factors. We
  // iterate `all` (mixed verified + unverified) — `totp` is typed
  // verified-only by @supabase/auth-js.
  const list = await supabase.auth.mfa.listFactors();
  for (const factor of list.data?.all ?? []) {
    if (factor.factor_type === "totp" && factor.status === "unverified") {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `TOTP (${new Date().toISOString().slice(0, 10)})`,
  });

  if (error || !data) {
    return { ok: false, message: error?.message ?? "enrolment failed" };
  }

  return {
    ok: true,
    factorId: data.id,
    qrCodeSvg: data.totp.qr_code,
    secret: data.totp.secret,
  };
}

// Complete enrolment: user enters the code from their authenticator,
// we issue a challenge + verify in one go. Supabase flips the factor
// to status='verified' AND elevates the session to AAL2 in one step,
// so the user lands at the dashboard immediately on success.
export async function verifyEnrolment(input: {
  factorId: string;
  code: string;
}): Promise<VerifyResult> {
  const parsed = VerifyInput.safeParse({
    factorId: input.factorId,
    code: input.code.replace(/\s+/g, ""),
  });
  if (!parsed.success) return { ok: false, message: "invalid code" };

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "not signed in" };

  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: parsed.data.factorId,
    code: parsed.data.code,
  });

  if (error) return { ok: false, message: "code didn't match — try again" };

  // Audit. Best-effort: if there's no active org we still want the
  // verify to succeed (the user is mid-onboarding), so swallow.
  const orgId = await getActiveOrg();
  if (orgId) {
    await audit.log({
      organisationId: orgId,
      actorUserId: user.id,
      action: "mfa.enrolled",
      targetType: "user",
      targetId: user.id,
    });
  }

  return { ok: true };
}

// Challenge an existing verified factor. Used by the wall on every
// fresh sign-in for users who already have TOTP set up. Same shape as
// verifyEnrolment — different audit semantics (no row written; this
// is just a session-AAL flip, captured by `login.success` already).
export async function verifyChallenge(input: {
  factorId: string;
  code: string;
}): Promise<VerifyResult> {
  const parsed = VerifyInput.safeParse({
    factorId: input.factorId,
    code: input.code.replace(/\s+/g, ""),
  });
  if (!parsed.success) return { ok: false, message: "invalid code" };

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: parsed.data.factorId,
    code: parsed.data.code,
  });

  if (error) return { ok: false, message: "code didn't match — try again" };
  return { ok: true };
}

// Disable a factor. Requires AAL2 — Supabase enforces this when the
// org-level "MFA enforced" setting is on, but we add an explicit check
// here in case enforcement is off at the project level. Belt + braces:
// a session-stealing attacker should not be able to disable MFA.
export async function disableMfa(input: { factorId: string }): Promise<VerifyResult> {
  const parsed = DisableInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: "invalid factor id" };

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "not signed in" };

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") {
    return { ok: false, message: "complete an MFA challenge before disabling" };
  }

  const { error } = await supabase.auth.mfa.unenroll({ factorId: parsed.data.factorId });
  if (error) return { ok: false, message: error.message };

  // Audit. Look up the user's role in the active org so the audit row
  // lands with the right organisation_id (audit_log requires NOT NULL
  // org). We've already verified membership via session.
  const orgId = await getActiveOrg();
  if (orgId) {
    const member = await withUser(async (db) => {
      const [row] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(eq(memberships.userId, user.id), eq(memberships.organisationId, orgId)),
        )
        .limit(1);
      return row;
    });
    if (member) {
      await audit.log({
        organisationId: orgId,
        actorUserId: user.id,
        action: "mfa.disabled",
        targetType: "user",
        targetId: user.id,
      });
    }
  }

  return { ok: true };
}

// Sign out from inside the MfaWall. Useful escape hatch when the user
// has lost their authenticator and needs to reach support — without
// this, they'd be stuck on the wall with no way out.
export async function signOutFromWall(): Promise<void> {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/login");
}
