"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { buildResetUrl, mintResetToken } from "@/lib/auth/password-reset";
import { memberships, users } from "@/lib/db/schema";
import { EmailSendError, sendEmail } from "@/lib/email/send";
import { renderPasswordReset } from "@/lib/email/templates/password-reset";
import { rateLimit } from "@/lib/public/rate-limit";
import { audit } from "@/lib/server/admin/audit";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { adminDb } from "@/lib/server/admin/db";

// Support-triggered password reset. Support TRIGGERS the standard reset email
// to the user's address ON FILE — it never sees, sets, or routes the
// password. Strictly gated (requirePlatformAdmin) and dual-audited. See
// docs/specs/password-reset.md.

// Blast-radius cap per admin — a compromised admin account can't silently
// reset thousands of accounts.
const ADMIN_ATTEMPTS = 20;
const ADMIN_WINDOW_SEC = 60 * 60;

const Schema = z.object({
  userId: z.string().uuid(),
  reason: z.string().trim().min(3, "Give a brief reason or ticket reference.").max(500),
});

export type TriggerResetState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; email: string };

export async function triggerPasswordReset(
  _prev: TriggerResetState,
  formData: FormData,
): Promise<TriggerResetState> {
  const parsed = Schema.safeParse({
    userId: formData.get("userId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  // Re-check authorization in the action (not just the edge proxy gate).
  const session = await requirePlatformAdmin();

  const limit = await rateLimit(
    `pwreset:admin:${session.userId}`,
    ADMIN_ATTEMPTS,
    ADMIN_WINDOW_SEC,
  );
  if (!limit.ok) {
    return { status: "error", message: "Reset limit reached for now. Try again later." };
  }

  const db = adminDb();
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, parsed.data.userId))
    .limit(1);
  if (!user) return { status: "error", message: "No such user." };

  const { tokenId, token } = await mintResetToken(user.id, {
    initiatedByAdminId: session.userId,
  });

  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
  const { subject, html, text } = await renderPasswordReset({
    resetUrl: buildResetUrl({ token, appUrl }),
    initiatedByAdmin: true,
  });

  // Always to the address ON FILE — an admin-supplied destination is never
  // accepted (the form only sends userId + reason).
  try {
    await sendEmail({
      to: user.email,
      subject,
      html,
      text,
      unsubscribeUrl: `${appUrl.replace(/\/$/, "")}/login`,
      oneClickUnsubscribe: false,
      idempotencyKey: `pwreset:${tokenId}`,
    });
  } catch (err) {
    // Log a bland code only — a Resend error can echo the recipient address
    // (gdpr.md §logs). The minted token is harmless (expires/swept).
    const code = err instanceof EmailSendError ? err.code : "send-failed";
    console.error("[password-reset] admin trigger send failed:", code);
    return { status: "error", message: "Couldn't send the reset email. Please try again." };
  }

  // Staff action (platform_audit_log) + operator-visible org audit.
  await platformAudit.log({
    actorEmail: session.email,
    action: "password_reset.triggered",
    targetType: "user",
    targetId: user.id,
    metadata: { reason: parsed.data.reason },
  });
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
      // Operator-readable log: record only that support triggered it. The
      // staff member's identity stays in platform_audit_log (deny-all),
      // never crossed into a tenant-readable log.
      metadata: { via: "admin" },
    });
  }

  return { status: "success", email: user.email };
}
