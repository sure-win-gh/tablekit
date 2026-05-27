"use server";

import { z } from "zod";

import { getPlaceDetails } from "@/lib/google/places";
import { createClaimableAccount } from "@/lib/outreach/create-claimable";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";

// In dev we tolerate the env being unset (typical local-first setup);
// in prod a missing NEXT_PUBLIC_APP_URL would mint localhost claim
// URLs and silently break outreach, so we fail loud instead.
function resolveAppUrl(): string {
  const fromEnv = process.env["NEXT_PUBLIC_APP_URL"];
  if (fromEnv) return fromEnv;
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("createOutreachClaim: NEXT_PUBLIC_APP_URL is not set in production.");
  }
  return "http://localhost:3000";
}

const Schema = z.object({
  placeId: z.string().min(1, "Required").max(200),
  prospectEmail: z.string().email("Invalid email"),
  prospectName: z.string().max(200).optional(),
});

export type CreateClaimState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> }
  | {
      status: "success";
      claimUrl: string;
      organisationName: string;
      prospectEmail: string;
      expiresAt: string;
    };

// Returns the plaintext claim URL once, via form state. Token is never
// echoed to URL or DB plaintext; closing the page loses it.
export async function createOutreachClaim(
  _prev: CreateClaimState,
  formData: FormData,
): Promise<CreateClaimState> {
  const parsed = Schema.safeParse({
    placeId: formData.get("placeId"),
    prospectEmail: formData.get("prospectEmail"),
    prospectName: formData.get("prospectName") || undefined,
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const { userId } = await requirePlatformAdmin();
  const appUrl = resolveAppUrl();

  const details = await getPlaceDetails(parsed.data.placeId);
  if (!details.ok) {
    const msg =
      details.status === "not-configured"
        ? "GOOGLE_PLACES_API_KEY is not set."
        : `Places API: ${details.error ?? `status ${details.status}`}`;
    return { status: "error", message: msg };
  }

  const result = await createClaimableAccount({
    place: details.place,
    prospectEmail: parsed.data.prospectEmail,
    ...(parsed.data.prospectName ? { prospectName: parsed.data.prospectName } : {}),
    createdByUserId: userId,
    appUrl,
  });

  return {
    status: "success",
    claimUrl: result.claimUrl,
    organisationName: details.place.displayName,
    prospectEmail: parsed.data.prospectEmail,
    expiresAt: result.expiresAt.toISOString(),
  };
}
