"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { supabaseServer } from "@/lib/db/supabase-server";
import { hashForLookup } from "@/lib/security/crypto";
import { ipFromHeaders, peekRateLimit, rateLimit } from "@/lib/public/rate-limit";
import { establishActiveOrg } from "@/lib/server/admin/active-org";
import { audit } from "@/lib/server/admin/audit";

// Brute-force / credential-stuffing throttle for the auth surface,
// per docs/playbooks/security.md: 5 attempts per IP per 15 minutes,
// plus 3 per account per hour. Buckets are keyed by IP and by a
// non-reversible hash of the email (never the raw address). The
// limiter fails open if Upstash isn't configured (dev/CI).
const IP_ATTEMPTS = 5;
const IP_WINDOW_SEC = 15 * 60;
const ACCOUNT_ATTEMPTS = 3;
const ACCOUNT_WINDOW_SEC = 60 * 60;

const RATE_LIMITED_MESSAGE = "Too many attempts. Please wait a few minutes and try again.";

async function clientIp(): Promise<string> {
  return ipFromHeaders(await headers());
}

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

  // Throttle before touching Supabase. IP first (cheap, blunt) counts
  // every attempt; the per-account bucket counts *failures only*, so a
  // member logging in legitimately (across devices, say) never locks
  // themselves out, while credential-stuffing one account from many IPs
  // still trips at ACCOUNT_ATTEMPTS failures/hour. We peek the account
  // bucket here and record a hit only on a failed auth below.
  const ip = await clientIp();
  const ipLimit = await rateLimit(`login:ip:${ip}`, IP_ATTEMPTS, IP_WINDOW_SEC, {
    failOpen: false,
  });
  if (!ipLimit.ok) {
    return { status: "error", message: RATE_LIMITED_MESSAGE };
  }
  const accountBucket = `login:acct:${hashForLookup(parsed.data.email, "email")}`;
  const accountLimit = await peekRateLimit(accountBucket, ACCOUNT_ATTEMPTS, ACCOUNT_WINDOW_SEC, {
    failOpen: false,
  });
  if (!accountLimit.ok) {
    return { status: "error", message: RATE_LIMITED_MESSAGE };
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error || !data.user) {
    // Record the failed attempt against the per-account bucket.
    await rateLimit(accountBucket, ACCOUNT_ATTEMPTS, ACCOUNT_WINDOW_SEC, { failOpen: false });
    // We deliberately don't distinguish "wrong password" from "no such
    // user" — same message for both denies account enumeration.
    return { status: "error", message: "Invalid email or password." };
  }

  const orgId = await establishActiveOrg(data.user.id);
  if (orgId) {
    await audit.log({
      organisationId: orgId,
      actorUserId: data.user.id,
      action: "login.success",
      targetType: "user",
      targetId: data.user.id,
      metadata: { method: "password" },
    });
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

  // Same IP throttle — magic-link send is an email-spam vector.
  const ip = await clientIp();
  const ipLimit = await rateLimit(`login:ip:${ip}`, IP_ATTEMPTS, IP_WINDOW_SEC, {
    failOpen: false,
  });
  if (!ipLimit.ok) {
    return { status: "error", message: RATE_LIMITED_MESSAGE };
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
