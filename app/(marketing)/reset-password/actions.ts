"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { consumeResetToken } from "@/lib/auth/password-reset";
import { memberships } from "@/lib/db/schema";
import { ipFromHeaders, rateLimit } from "@/lib/public/rate-limit";
import { adminDb } from "@/lib/server/admin/db";
import { audit } from "@/lib/server/admin/audit";
import { supabaseAdmin } from "@/lib/server/admin/supabase-admin";

const IP_ATTEMPTS = 5;
const IP_WINDOW_SEC = 15 * 60;

const RATE_LIMITED = "Too many attempts. Please wait a few minutes and try again.";
const INVALID_TOKEN = "This reset link is invalid or has expired. Request a new one.";

// Password policy matches signup (min 12).
const ResetSchema = z.object({
  token: z.string().min(1).max(256),
  password: z.string().min(12, "Use at least 12 characters.").max(128),
});

export type ResetPasswordState = { status: "idle" } | { status: "error"; message: string };

export async function resetPassword(
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const parsed = ResetSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    const pwIssue = parsed.error.issues.find((i) => i.path[0] === "password");
    return { status: "error", message: pwIssue?.message ?? INVALID_TOKEN };
  }

  const ip = ipFromHeaders(await headers());
  const ipLimit = await rateLimit(`pwreset:confirm:ip:${ip}`, IP_ATTEMPTS, IP_WINDOW_SEC, {
    failOpen: false,
  });
  if (!ipLimit.ok) return { status: "error", message: RATE_LIMITED };

  // Atomically consume the token (single-use). Null = invalid/expired/used.
  const consumed = await consumeResetToken(parsed.data.token);
  if (!consumed) return { status: "error", message: INVALID_TOKEN };
  const userId = consumed.userId;

  // Set the new password via the service-role admin client.
  const { error } = await supabaseAdmin().auth.admin.updateUserById(userId, {
    password: parsed.data.password,
  });
  if (error) {
    console.error("[password-reset] updateUserById failed:", error.message);
    return {
      status: "error",
      message: "We couldn't set your password. Please request a new link.",
    };
  }

  // Revoke the user's other sessions — a reset (possibly triggered by
  // compromise) should lock attackers out, not just change the password.
  // Best-effort: the password is already changed, so log and continue.
  try {
    await adminDb().execute(sql`delete from auth.sessions where user_id = ${userId}`);
  } catch (err) {
    console.error(
      "[password-reset] session revoke failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  const [m] = await adminDb()
    .select({ organisationId: memberships.organisationId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  if (m) {
    await audit.log({
      organisationId: m.organisationId,
      actorUserId: userId,
      action: "password_reset.completed",
      targetType: "user",
      targetId: userId,
      metadata: {},
    });
  }

  redirect("/login?reset=1");
}
