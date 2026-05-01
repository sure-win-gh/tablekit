"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { createDsarRequest } from "@/lib/dsar/create";
import { setMarketingConsent, type MarketingChannel } from "@/lib/guests/marketing-consent";
import { updateGuestContact } from "@/lib/guests/update-contact";
import { withUser } from "@/lib/db/client";
import { guests } from "@/lib/db/schema";
import { decryptPii, type Ciphertext } from "@/lib/security/crypto";
import { and, eq } from "drizzle-orm";

export type ContactActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved" };

const ContactSchema = z.object({
  guestId: z.string().uuid(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string().optional(),
});

export async function updateGuestContactAction(
  _prev: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  const { userId, orgId } = await requireRole("manager");

  const parsed = ContactSchema.safeParse({
    guestId: formData.get("guestId"),
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName") ?? "",
    email: formData.get("email"),
    phone: formData.get("phone") || undefined,
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check the contact details.",
    };
  }

  const r = await updateGuestContact(orgId, userId, parsed.data.guestId, {
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    email: parsed.data.email,
    ...(parsed.data.phone !== undefined ? { phone: parsed.data.phone } : {}),
  });
  if (!r.ok) {
    const message = {
      "guest-not-found": "Guest not found.",
      "email-taken": "Another guest in this organisation already uses that email.",
      "invalid-input": r.reason === "invalid-input" ? r.issues.join("; ") : "Invalid input.",
    }[r.reason];
    return { status: "error", message };
  }

  revalidatePath(`/dashboard/guests/${parsed.data.guestId}`);
  return { status: "saved" };
}

export type ConsentActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved" };

const ConsentSchema = z.object({
  guestId: z.string().uuid(),
  channel: z.enum(["email", "sms"]),
  consenting: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export async function setMarketingConsentAction(
  _prev: ConsentActionState,
  formData: FormData,
): Promise<ConsentActionState> {
  const { userId, orgId } = await requireRole("host");

  const parsed = ConsentSchema.safeParse({
    guestId: formData.get("guestId"),
    channel: formData.get("channel"),
    consenting: formData.get("consenting"),
  });
  if (!parsed.success) {
    return { status: "error", message: "Bad request." };
  }

  const r = await setMarketingConsent({
    organisationId: orgId,
    actorUserId: userId,
    guestId: parsed.data.guestId,
    channel: parsed.data.channel as MarketingChannel,
    consenting: parsed.data.consenting,
  });
  if (!r.ok) return { status: "error", message: "Guest not found." };

  revalidatePath(`/dashboard/guests/${parsed.data.guestId}`);
  return { status: "saved" };
}

export type EraseActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "created"; dsarId: string };

const EraseSchema = z.object({ guestId: z.string().uuid() });

// Operator-initiated erasure routes through the same DSAR inbox a
// guest-submitted erasure request lands in. Reuses the 30-day SLA,
// audit log, and the existing /dashboard/privacy-requests workflow.
// The actual data scrub is performed by the (deferred) DSAR scrub
// job — this action only creates the request.
export async function requestGuestErasureAction(
  _prev: EraseActionState,
  formData: FormData,
): Promise<EraseActionState> {
  const { userId, orgId } = await requireRole("manager");

  const parsed = EraseSchema.safeParse({ guestId: formData.get("guestId") });
  if (!parsed.success) return { status: "error", message: "Bad request." };

  // We need the guest's email to create the DSAR. Decrypt server-side
  // under the same withUser() RLS context that gates the rest of the
  // dashboard reads.
  const guest = await withUser(async (db) => {
    const [row] = await db
      .select({ id: guests.id, emailCipher: guests.emailCipher })
      .from(guests)
      .where(and(eq(guests.id, parsed.data.guestId), eq(guests.organisationId, orgId)))
      .limit(1);
    return row;
  });
  if (!guest) return { status: "error", message: "Guest not found." };

  const email = await decryptPii(orgId, guest.emailCipher as Ciphertext);

  const r = await createDsarRequest({
    organisationId: orgId,
    kind: "erase",
    requesterEmail: email,
    message: `Operator-initiated erasure for guest ${parsed.data.guestId} (actor=${userId ?? "system"}).`,
  });
  if (!r.ok) return { status: "error", message: r.issues.join("; ") };

  revalidatePath(`/dashboard/guests/${parsed.data.guestId}`);
  revalidatePath(`/dashboard/privacy-requests`);
  return { status: "created", dsarId: r.dsarId };
}
