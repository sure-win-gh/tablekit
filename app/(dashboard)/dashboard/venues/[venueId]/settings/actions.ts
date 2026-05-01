"use server";

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { startOnboarding } from "@/lib/stripe/connect";
import { venues } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import { audit } from "@/lib/server/admin/audit";
import { validateSlug } from "@/lib/venues/slug";

const Schema = z.object({
  venueId: z.uuid(),
  name: z.string().min(1, "Required").max(120),
  // Empty string = clear the slug back to UUID-only routing. Format
  // + reserved-name validation runs after the basic Zod parse so we
  // can return a precise message (validateSlug owns those rules).
  slug: z.string().trim().max(60).optional(),
  timezone: z.string().min(1).max(60),
  locale: z.string().min(1).max(20),
  // Reviews — Phase 1. All optional so legacy form posts still parse.
  reviewRequestEnabled: z.coerce.boolean().optional(),
  reviewRequestDelayHours: z.coerce
    .number()
    .int()
    .refine((v) => [24, 48, 72].includes(v), {
      message: "Pick 24, 48 or 72",
    })
    .optional(),
  // Place IDs are URL-safe base64-ish: letters, digits, `_`, `-`. Reject
  // pasted URLs / typos early so we don't ship a broken Google deep
  // link to guests.
  googlePlaceId: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9_-]*$/, "Place ID should look like ChIJ… (letters, digits, _ or -)")
    .optional(),
  // Phase 7a — public showcase on the booking widget
  showcaseEnabled: z.coerce.boolean().optional(),
  // Phase 6 — escalation alerts
  escalationEnabled: z.coerce.boolean().optional(),
  escalationThreshold: z.coerce
    .number()
    .int()
    .refine((v) => [1, 2, 3].includes(v), { message: "Pick 1, 2 or 3" })
    .optional(),
  // Empty string = clear (fall back to org-owner email).
  escalationEmail: z
    .string()
    .trim()
    .max(254)
    .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: "Enter a valid email or leave blank",
    })
    .optional(),
});

export type UpdateVenueState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> }
  | { status: "saved" };

export async function updateVenue(
  _prev: UpdateVenueState,
  formData: FormData,
): Promise<UpdateVenueState> {
  const parsed = Schema.safeParse({
    venueId: formData.get("venue_id"),
    name: formData.get("name"),
    slug: formData.get("slug"),
    timezone: formData.get("timezone"),
    locale: formData.get("locale"),
    // Checkboxes only POST when checked, so absence == disabled.
    reviewRequestEnabled: formData.get("review_request_enabled") === "on",
    reviewRequestDelayHours: formData.get("review_request_delay_hours"),
    googlePlaceId: formData.get("google_place_id"),
    showcaseEnabled: formData.get("showcase_enabled") === "on",
    escalationEnabled: formData.get("escalation_enabled") === "on",
    escalationThreshold: formData.get("escalation_threshold"),
    escalationEmail: formData.get("escalation_email"),
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const { orgId, userId } = await requireRole("manager");
  const {
    venueId,
    name,
    timezone,
    locale,
    reviewRequestEnabled,
    reviewRequestDelayHours,
    showcaseEnabled,
    escalationEnabled,
    escalationThreshold,
  } = parsed.data;
  const trimmedPlaceId = parsed.data.googlePlaceId?.trim() ?? "";
  const trimmedEscalationEmail = parsed.data.escalationEmail?.trim() ?? "";

  // Slug: empty string clears it; otherwise validate format + reserved
  // names. Uniqueness is enforced by the DB partial unique index and
  // surfaced below via the 23505 catch.
  const rawSlug = (parsed.data.slug ?? "").trim();
  let nextSlug: string | null | undefined;
  if (rawSlug === "") {
    nextSlug = null;
  } else {
    const slugCheck = validateSlug(rawSlug);
    if (!slugCheck.ok) {
      return {
        status: "error",
        message: slugCheck.message,
        fieldErrors: { slug: [slugCheck.message] },
      };
    }
    nextSlug = slugCheck.slug;
  }

  // Read existing settings so we merge instead of clobbering keys we
  // don't manage here (other phases may add their own JSONB entries).
  // The `and(org_id = orgId)` in the WHERE is what stops a managed
  // user from poking another org's venue with a crafted venueId —
  // adminDb() bypasses RLS, so this check carries the weight.
  const db = adminDb();
  const [existing] = await db
    .select({ settings: venues.settings, slug: venues.slug })
    .from(venues)
    .where(and(eq(venues.id, venueId), eq(venues.organisationId, orgId)))
    .limit(1);
  if (!existing) {
    return { status: "error", message: "Venue not found or not in your organisation." };
  }
  const slugChanged = nextSlug !== existing.slug;
  const mergedSettings = {
    ...((existing.settings as Record<string, unknown>) ?? {}),
    reviewRequestEnabled: reviewRequestEnabled ?? true,
    reviewRequestDelayHours: reviewRequestDelayHours ?? 24,
    googlePlaceId: trimmedPlaceId.length > 0 ? trimmedPlaceId : null,
    showcaseEnabled: showcaseEnabled ?? false,
    escalationEnabled: escalationEnabled ?? true,
    escalationThreshold: escalationThreshold ?? 2,
    escalationEmail: trimmedEscalationEmail.length > 0 ? trimmedEscalationEmail : null,
  };

  let updated: { id: string } | undefined;
  try {
    const rows = await db
      .update(venues)
      .set({
        name,
        timezone,
        locale,
        settings: mergedSettings,
        ...(slugChanged ? { slug: nextSlug } : {}),
      })
      .where(and(eq(venues.id, venueId), eq(venues.organisationId, orgId)))
      .returning({ id: venues.id });
    updated = rows[0];
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return {
        status: "error",
        message: "That slug is already taken.",
        fieldErrors: { slug: ["That slug is already taken."] },
      };
    }
    throw err;
  }

  if (!updated) {
    return {
      status: "error",
      message: "Venue not found or not in your organisation.",
    };
  }

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "venue.updated",
    targetType: "venue",
    targetId: updated.id,
    metadata: {
      name,
      timezone,
      locale,
      reviewRequestEnabled: mergedSettings.reviewRequestEnabled,
      reviewRequestDelayHours: mergedSettings.reviewRequestDelayHours,
      googlePlaceIdSet: mergedSettings.googlePlaceId !== null,
    },
  });

  if (slugChanged) {
    await audit.log({
      organisationId: orgId,
      actorUserId: userId,
      action: "venue.slug_updated",
      targetType: "venue",
      targetId: updated.id,
      metadata: { slugSet: nextSlug !== null },
    });
  }

  revalidatePath(`/dashboard/venues/${updated.id}`, "layout");
  return { status: "saved" };
}

function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const direct = (err as { code?: unknown }).code;
  if (direct === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && (cause as { code?: unknown }).code === "23505") {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stripe Connect onboarding kickoff
// ---------------------------------------------------------------------------
//
// Returns a redirect URL on success (client does window.location.href).
// Can't redirect from a server action directly to a third-party host
// without a full response object — Next's `redirect()` is for internal
// routes only.

const StartOnboardingSchema = z.object({
  venueId: z.uuid(),
});

export type StartStripeOnboardingState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "redirect"; url: string };

export async function startStripeOnboardingAction(
  _prev: StartStripeOnboardingState,
  formData: FormData,
): Promise<StartStripeOnboardingState> {
  const parsed = StartOnboardingSchema.safeParse({ venueId: formData.get("venueId") });
  if (!parsed.success) {
    return { status: "error", message: "Invalid request." };
  }

  const { orgId, userId } = await requireRole("manager");

  // Reconstruct the base URL from the request headers — the return_url
  // Stripe hops us back to must match this host.
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const protocol = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const appUrl = `${protocol}://${host}`;

  const r = await startOnboarding(orgId, userId, appUrl);
  if (!r.ok) {
    if (r.reason === "payments-disabled") {
      return { status: "error", message: "Payments are currently disabled." };
    }
    // stripe-error carries the actual Stripe message — surface it so
    // the operator can fix it (e.g. "sign up for Connect at …").
    return {
      status: "error",
      message: `Stripe: ${r.message}`,
    };
  }

  return { status: "redirect", url: r.url };
}
