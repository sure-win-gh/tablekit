"use server";

import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { buildResetUrl, mintResetToken } from "@/lib/auth/password-reset";
import { memberships, users } from "@/lib/db/schema";
import { EmailSendError, sendEmail } from "@/lib/email/send";
import { renderPasswordReset } from "@/lib/email/templates/password-reset";
import { ipFromHeaders, rateLimit } from "@/lib/public/rate-limit";
import { hashForLookup } from "@/lib/security/crypto";
import { adminDb } from "@/lib/server/admin/db";
import { audit } from "@/lib/server/admin/audit";

// Auth-surface throttle per docs/playbooks/security.md: 5/IP/15min, plus a
// per-email cap so a forgotten-password form can't be used to email-bomb a
// victim. Both consume on every request (there is no success/failure to
// protect — every well-formed request looks the same to the caller).
const IP_ATTEMPTS = 5;
const IP_WINDOW_SEC = 15 * 60;
const EMAIL_ATTEMPTS = 3;
const EMAIL_WINDOW_SEC = 60 * 60;

const RATE_LIMITED = "Too many attempts. Please wait a few minutes and try again.";

const ForgotSchema = z.object({ email: z.string().email().max(320) });

export type ForgotPasswordState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "email_sent"; email: string };

export async function requestPasswordReset(
  _prev: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const parsed = ForgotSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { status: "error", message: "Enter a valid email address." };
  }
  const email = parsed.data.email;

  // Throttle before any user lookup — IP first, then per-email. Unknown
  // emails consume the buckets too, so timing/rate-limit can't be used to
  // enumerate accounts.
  const ip = ipFromHeaders(await headers());
  const ipLimit = await rateLimit(`pwreset:ip:${ip}`, IP_ATTEMPTS, IP_WINDOW_SEC);
  if (!ipLimit.ok) return { status: "error", message: RATE_LIMITED };
  const emailLimit = await rateLimit(
    `pwreset:email:${hashForLookup(email, "email")}`,
    EMAIL_ATTEMPTS,
    EMAIL_WINDOW_SEC,
  );
  if (!emailLimit.ok) return { status: "error", message: RATE_LIMITED };

  try {
    await dispatchResetEmail(email);
  } catch (err) {
    // Never surface failure to the caller — the response is neutral whether
    // or not the account exists or the send succeeded. Log only a bland
    // code: a Resend error message can echo the recipient address
    // (e.g. invalid_to_address), which must not land in logs (gdpr.md §logs).
    const code = err instanceof EmailSendError ? err.code : "dispatch-error";
    console.error("[password-reset] dispatch failed:", code);
  }

  // Always the same neutral result — no account enumeration.
  return { status: "email_sent", email };
}

// Resolve the email to a real account and, if found, mint + email a reset
// link. Sends to the address ON FILE, never the raw input. A no-op for an
// unknown email (no token row created).
async function dispatchResetEmail(email: string): Promise<void> {
  const db = adminDb();
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) return;

  const { tokenId, token } = await mintResetToken(user.id);

  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
  const { subject, html, text } = await renderPasswordReset({
    resetUrl: buildResetUrl({ token, appUrl }),
    initiatedByAdmin: false,
  });

  await sendEmail({
    to: user.email,
    subject,
    html,
    text,
    // Security email, not marketing: the List-Unsubscribe points at the
    // login page (a non-POST URL) and one-click is off, mirroring the
    // operator escalation-alert precedent.
    unsubscribeUrl: `${appUrl.replace(/\/$/, "")}/login`,
    oneClickUnsubscribe: false,
    idempotencyKey: `pwreset:${tokenId}`,
  });

  // Org-scoped audit (mirrors login.success). A user always has at least
  // one membership; if somehow not, skip rather than fail the reset.
  const [m] = await db
    .select({ organisationId: memberships.organisationId })
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .limit(1);
  if (m) {
    await audit.log({
      organisationId: m.organisationId,
      actorUserId: user.id,
      action: "password_reset.requested",
      targetType: "user",
      targetId: user.id,
      metadata: { via: "self" },
    });
  }
}
