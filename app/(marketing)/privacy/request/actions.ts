"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";

import { organisations } from "@/lib/db/schema";
import { createDsarRequest } from "@/lib/dsar/create";
import { captchaEnabled, verifyCaptcha } from "@/lib/public/captcha";
import { ipFromHeaders, rateLimit } from "@/lib/public/rate-limit";
import { adminDb } from "@/lib/server/admin/db";

// Public privacy-request submission. Anonymous endpoint — guards are
// captcha + IP rate limit. The org slug routes the request to the
// right inbox; lookups go through adminDb because public reads of
// organisations.slug aren't covered by RLS.

const Form = z.object({
  orgSlug: z.string().min(1).max(64),
  kind: z.enum(["export", "rectify", "erase"]),
  email: z.string().email(),
  message: z.string().max(2000).optional(),
  captchaToken: z.string().optional(),
});

export type SubmitDsarState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success" };

const RATE_LIMIT = { perHour: 5, windowSec: 60 * 60 } as const;

export async function submitDsarRequest(
  _prev: SubmitDsarState,
  formData: FormData,
): Promise<SubmitDsarState> {
  const parsed = Form.safeParse({
    orgSlug: formData.get("orgSlug"),
    kind: formData.get("kind"),
    email: formData.get("email"),
    message: formData.get("message") || undefined,
    captchaToken: formData.get("captchaToken") || undefined,
  });
  if (!parsed.success) {
    return { status: "error", message: "Check the form — some fields look invalid." };
  }

  // IP rate limit first — cheapest gate. Bucketed per (ip, slug) so a
  // burst against one venue doesn't take down the public form for the
  // rest of the world.
  const hdr = await headers();
  const ip = ipFromHeaders(hdr);
  const bucket = `dsar:${ip}:${parsed.data.orgSlug}`;
  const rl = await rateLimit(bucket, RATE_LIMIT.perHour, RATE_LIMIT.windowSec);
  if (!rl.ok) {
    return {
      status: "error",
      message: "Too many requests from this address — please try again later.",
    };
  }

  // Captcha if configured. captchaEnabled() returns false when the
  // secret isn't set (local dev / CI) — verifyCaptcha then no-ops.
  if (captchaEnabled()) {
    const captcha = await verifyCaptcha(parsed.data.captchaToken, ip);
    if (!captcha.ok) {
      return {
        status: "error",
        message:
          captcha.reason === "missing-token"
            ? "Please complete the captcha before submitting."
            : "Couldn't verify the captcha. Try again.",
      };
    }
  }

  // Resolve slug → org id. Public read; uses adminDb because the
  // organisations table has no anon SELECT policy.
  const [org] = await adminDb()
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.slug, parsed.data.orgSlug))
    .limit(1);
  if (!org) {
    return { status: "error", message: "We couldn't find that organisation. Check the link." };
  }

  const r = await createDsarRequest({
    organisationId: org.id,
    kind: parsed.data.kind,
    requesterEmail: parsed.data.email,
    ...(parsed.data.message ? { message: parsed.data.message } : {}),
  });

  if (!r.ok) {
    return { status: "error", message: r.issues.join("; ") };
  }
  return { status: "success" };
}
