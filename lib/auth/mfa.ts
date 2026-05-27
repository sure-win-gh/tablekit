// MFA (TOTP) state + gate helpers.
//
// Supabase Auth tracks factors in `auth.mfa_factors` and exposes them
// via `supabase.auth.mfa.*`. We don't mirror anything in our own
// schema — the source of truth is Supabase, and AAL2 is a session
// attribute we read fresh on every request.
//
// Gate model: owners and managers MUST have a verified TOTP factor
// AND the current session must be at aal2. Hosts are exempt (MFA is
// optional for hosts per docs/specs/auth.md). The dashboard layout
// reads `getMfaContext()` and renders an MfaWall when the gate fires;
// the wall handles both enrolment (no factor) and challenge (factor
// exists but session at aal1) without leaving the gated state.

import "server-only";

import { hasRole, type OrgRole } from "./role-level";

import { supabaseServer } from "@/lib/db/supabase-server";

export type AalLevel = "aal1" | "aal2";

export type MfaState = {
  // Has at least one VERIFIED TOTP factor. Unverified factors (mid-
  // enrolment) don't count — they exist transiently and would cause
  // the wall to flip from "enrol" to "challenge" before the user has
  // actually saved the secret.
  hasVerifiedFactor: boolean;
  // The first verified TOTP factor id, if any. Used by the challenge
  // flow on the wall.
  factorId: string | null;
  currentLevel: AalLevel;
  nextLevel: AalLevel;
};

export async function getMfaState(): Promise<MfaState | null> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [aalResult, factorsResult] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.auth.mfa.listFactors(),
  ]);

  const aal = aalResult.data;
  const factors = factorsResult.data;
  // factors.totp is typed verified-only by @supabase/auth-js — its
  // existence implies hasVerifiedFactor=true. Unverified factors land
  // only in factors.all and are handled by enrolTotp's cleanup pass.
  const verified = factors?.totp?.[0] ?? null;

  return {
    hasVerifiedFactor: Boolean(verified),
    factorId: verified?.id ?? null,
    currentLevel: (aal?.currentLevel ?? "aal1") as AalLevel,
    nextLevel: (aal?.nextLevel ?? "aal1") as AalLevel,
  };
}

// True for owner and manager. Hosts are not required to enrol TOTP.
export function isMfaRequired(role: OrgRole): boolean {
  return hasRole(role, "manager");
}

export type MfaGateDecision =
  | { kind: "pass" }
  | { kind: "enrol"; factorId: null }
  | { kind: "challenge"; factorId: string };

export type MfaGateOptions = {
  // Org was created via the outreach pre-populated-accounts flow
  // (organisations.outreach_source IS NOT NULL). For these orgs we
  // skip the TOTP wall entirely — the prospect's first-login friction
  // matters more than enforcing 2FA on a freshly-claimed account.
  // The operator can still enrol from /dashboard/settings/security.
  outreachOrigin?: boolean;
};

// Decide what to render given a role + MFA state. Pure — no I/O.
// Centralised here so the layout, server actions, and any future
// API key-bypass paths agree on the rule.
export function decideMfaGate(
  role: OrgRole,
  mfa: MfaState,
  opts: MfaGateOptions = {},
): MfaGateDecision {
  if (opts.outreachOrigin) return { kind: "pass" };
  if (!isMfaRequired(role)) return { kind: "pass" };
  if (mfa.currentLevel === "aal2") return { kind: "pass" };
  if (mfa.hasVerifiedFactor && mfa.factorId) {
    return { kind: "challenge", factorId: mfa.factorId };
  }
  return { kind: "enrol", factorId: null };
}
