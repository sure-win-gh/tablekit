"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { makeOrgSlug } from "@/lib/auth/slug";
import { supabaseServer } from "@/lib/db/supabase-server";
import { memberships, organisations } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import { audit } from "@/lib/server/admin/audit";

const SignupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(128),
  fullName: z.string().min(1).max(120),
  orgName: z.string().min(1).max(120),
});

export type SignupState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> }
  | { status: "needs_confirm"; email: string };

export async function signUp(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const parsed = SignupSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    fullName: formData.get("full_name"),
    orgName: formData.get("org_name"),
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const { email, password, fullName, orgName } = parsed.data;

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

  // Create the org + owner membership. adminDb() bypasses RLS because
  // the user has no membership yet — they can't see their own org
  // until this insert lands.
  //
  // The trigger on auth.users → public.users fires first, so by the
  // time we hit public.memberships the user row exists for its FK.
  const orgSlug = makeOrgSlug(orgName);
  const db = adminDb();
  const orgId = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organisations)
      .values({ name: orgName, slug: orgSlug })
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

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "signup",
    targetType: "user",
    targetId: userId,
    metadata: { orgSlug },
  });

  // If Supabase's "Confirm email" setting is on (default), no session
  // yet — show a "check your email" screen. If it's off, session is
  // live and we can drop the user onto the dashboard.
  if (!authData.session) {
    return { status: "needs_confirm", email };
  }

  redirect("/dashboard");
}
