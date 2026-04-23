"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { supabaseServer } from "@/lib/db/supabase-server";

const PasswordLoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(128),
});

const MagicLinkSchema = z.object({
  email: z.string().email().max(320),
});

export type LoginState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "magic_sent"; email: string };

export async function signInWithPassword(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = PasswordLoginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { status: "error", message: "Enter a valid email and password." };
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    // We deliberately don't distinguish "wrong password" from "no such
    // user" — same message for both denies account enumeration.
    return { status: "error", message: "Invalid email or password." };
  }

  redirect("/dashboard");
}

export async function signInWithMagicLink(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = MagicLinkSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { status: "error", message: "Enter a valid email." };
  }

  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      // `shouldCreateUser: false` — magic link won't sign up new users.
      // Signup is the separate /signup flow.
      shouldCreateUser: false,
      emailRedirectTo: `${appUrl}/auth/callback?next=/dashboard`,
    },
  });

  if (error) {
    return { status: "error", message: "Couldn't send the link. Try again in a moment." };
  }

  return { status: "magic_sent", email: parsed.data.email };
}
