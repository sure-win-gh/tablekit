"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { setActiveOrg } from "@/lib/auth/active-org";
import { acceptInvitation, resolveInvitation } from "@/lib/auth/invitations";
import { audit } from "@/lib/server/admin/audit";
import { supabaseServer } from "@/lib/db/supabase-server";

const SignupAcceptSchema = z.object({
  token: z.string().min(1).max(128),
  password: z.string().min(12).max(128),
  fullName: z.string().min(1).max(120),
});

const ExistingAcceptSchema = z.object({
  token: z.string().min(1).max(128),
});

export type AcceptState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "needs_confirm"; email: string };

// New-user path: the invitee creates an account with the email the
// invite was issued for, and we attach the membership in the same
// confirmation flow. Supabase handles email-confirm; on first
// auth/callback the active-org cookie is initialised. The membership
// is created here BEFORE the email confirmation lands, so the user
// arrives at /dashboard with the right role on day one.
export async function acceptAsNewUser(
  _prev: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const parsed = SignupAcceptSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
    fullName: formData.get("full_name"),
  });
  if (!parsed.success) {
    return { status: "error", message: "Please correct the highlighted fields." };
  }

  const invite = await resolveInvitation(parsed.data.token);
  if (!invite) {
    return { status: "error", message: "This invite is no longer valid." };
  }

  // Supabase signUp uses the invite-bound email — the page already
  // displays it as read-only, so the form doesn't even submit it.
  const supabase = await supabaseServer();
  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email: invite.email,
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

  // Attach the membership + flip the invite to accepted in one tx.
  // If acceptInvitation reports the user-mirror missing, the trigger
  // hasn't fired yet — fall back to a tight retry. Rare but possible
  // in dev where the trigger lag is a few ms.
  let result = await acceptInvitation({ inviteId: invite.id, userId });
  if (!result.ok && result.reason === "missing-user") {
    await new Promise((r) => setTimeout(r, 200));
    result = await acceptInvitation({ inviteId: invite.id, userId });
  }
  if (!result.ok) {
    return { status: "error", message: "Couldn't attach you to the organisation." };
  }

  await audit.log({
    organisationId: invite.organisationId,
    actorUserId: userId,
    action: "invite.accepted",
    targetType: "invitation",
    targetId: invite.id,
    metadata: { email: invite.email, role: invite.role },
  });

  if (!authData.session) {
    return { status: "needs_confirm", email: invite.email };
  }

  await setActiveOrg(invite.organisationId);
  redirect("/dashboard");
}

// Existing-user path: the visitor is already authenticated as the
// invited email. Single button — accept the invite, set the active
// org to the new one, redirect. No password re-entry required.
export async function acceptAsExistingUser(input: { token: string }): Promise<void> {
  const parsed = ExistingAcceptSchema.safeParse(input);
  if (!parsed.success) redirect("/dashboard");

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const invite = await resolveInvitation(parsed.data.token);
  if (!invite) redirect("/dashboard");

  if ((user.email ?? "").toLowerCase() !== invite.email.toLowerCase()) {
    // Belt-and-braces — the page already filters this case before
    // showing the button, but a forged form post should still bounce.
    redirect("/dashboard");
  }

  const result = await acceptInvitation({ inviteId: invite.id, userId: user.id });
  if (!result.ok) redirect("/dashboard");

  await audit.log({
    organisationId: invite.organisationId,
    actorUserId: user.id,
    action: "invite.accepted",
    targetType: "invitation",
    targetId: invite.id,
    metadata: { email: invite.email, role: invite.role },
  });

  await setActiveOrg(invite.organisationId);
  redirect("/dashboard");
}
