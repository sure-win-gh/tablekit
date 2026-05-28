"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { setActiveOrg } from "@/lib/auth/active-org";
import { acceptClaim, resolveClaim } from "@/lib/outreach/claim-resolve";
import { audit } from "@/lib/server/admin/audit";
import { supabaseServer } from "@/lib/db/supabase-server";

const ClaimSchema = z.object({
  token: z.string().min(1).max(128),
  password: z.string().min(12).max(128),
  fullName: z.string().min(1).max(120),
});

// Hard-fail when running in prod without NEXT_PUBLIC_APP_URL — silent
// localhost fallback would mint a broken confirmation link.
function resolveAppUrl(): string {
  const fromEnv = process.env["NEXT_PUBLIC_APP_URL"];
  if (fromEnv) return fromEnv;
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("claimAccount: NEXT_PUBLIC_APP_URL is not set in production.");
  }
  return "http://localhost:3000";
}

export type ClaimState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "needs_confirm"; email: string };

// Same shape as app/invite/[token]/actions.ts's acceptAsNewUser, but
// the claim does THREE things instead of one:
//   1. Create the Supabase auth user (with the prospect's email — the
//      form locks the field so it always matches the claim row).
//   2. Insert memberships(role=owner) for the new user.
//   3. Flip organisations.claimed_at + outreach_claims.claimed_at.
// (2) and (3) happen atomically inside acceptClaim().
export async function claimAccount(_prev: ClaimState, formData: FormData): Promise<ClaimState> {
  const parsed = ClaimSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
    fullName: formData.get("full_name"),
  });
  if (!parsed.success) {
    return { status: "error", message: "Please correct the highlighted fields." };
  }

  const claim = await resolveClaim(parsed.data.token);
  if (!claim) {
    return { status: "error", message: "This claim link is no longer valid." };
  }

  const supabase = await supabaseServer();

  // Re-check session at the action boundary. The page-render guard
  // might have raced a stale-cookie sign-in across the round-trip,
  // and we don't want signUp + setActiveOrg to silently swap the live
  // user's active org out from under them.
  const { data: alreadyAuthed } = await supabase.auth.getUser();
  if (alreadyAuthed?.user) {
    return {
      status: "error",
      message: "You're already signed in. Sign out and reopen the link to claim.",
    };
  }

  const appUrl = resolveAppUrl();
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email: claim.prospectEmail,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
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

  // The auth.users → public.users trigger runs first; in dev a short
  // race window (~ms) can land us here before the mirror exists.
  // Retry once after a small pause — same belt-and-braces as the
  // invite accept path.
  let result = await acceptClaim({ claimId: claim.id, userId });
  if (!result.ok && result.reason === "missing-user") {
    await new Promise((r) => setTimeout(r, 200));
    result = await acceptClaim({ claimId: claim.id, userId });
  }
  if (!result.ok) {
    return { status: "error", message: "Couldn't attach your account to the venue." };
  }

  await audit.log({
    organisationId: claim.organisationId,
    actorUserId: userId,
    action: "outreach.claimed",
    targetType: "organisation",
    targetId: claim.organisationId,
  });

  if (!authData.session) {
    // Supabase "Confirm email" is on — finish via /auth/callback.
    return { status: "needs_confirm", email: claim.prospectEmail };
  }

  await setActiveOrg(claim.organisationId);
  redirect("/dashboard");
}
