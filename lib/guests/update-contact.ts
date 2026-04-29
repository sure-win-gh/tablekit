// updateGuestContact — re-encrypt + persist contact details for an
// existing guest. Used by the profile-page edit form.
//
// Strict org scoping: the guest must already belong to `organisationId`.
// On email change we recompute `email_hash`; the partial unique index
// `(organisation_id, email_hash) WHERE erased_at IS NULL` will fire if
// another live guest already holds that email — surfaced as the
// `email-taken` reason so the UI can prompt the operator. We never
// log plaintext PII.

import "server-only";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { guests } from "@/lib/db/schema";
import { encryptPii, hashForLookup } from "@/lib/security/crypto";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

const phoneRegex = /^\+?[0-9()\-\s]{7,20}$/;

export const updateContactInput = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(80, "First name too long"),
  lastName: z.string().trim().max(80, "Last name too long").default(""),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address")
    .max(200, "Email too long"),
  phone: z
    .string()
    .trim()
    .regex(phoneRegex, "Enter a valid phone number")
    .max(40, "Phone number too long")
    .or(z.literal("")) // allow clearing the phone
    .optional(),
});

export type UpdateContactInput = z.infer<typeof updateContactInput>;
export type UpdateContactRawInput = z.input<typeof updateContactInput>;

export type UpdateGuestContactResult =
  | { ok: true }
  | { ok: false; reason: "guest-not-found" }
  | { ok: false; reason: "email-taken" }
  | { ok: false; reason: "invalid-input"; issues: string[] };

export async function updateGuestContact(
  organisationId: string,
  actorUserId: string | null,
  guestId: string,
  raw: UpdateContactRawInput,
): Promise<UpdateGuestContactResult> {
  const parsed = updateContactInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid-input",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const input = parsed.data;

  const db = adminDb();

  const [existing] = await db
    .select({ id: guests.id, emailHash: guests.emailHash })
    .from(guests)
    .where(and(eq(guests.id, guestId), eq(guests.organisationId, organisationId)))
    .limit(1);
  if (!existing) return { ok: false, reason: "guest-not-found" };

  const newEmailHash = hashForLookup(input.email, "email");
  const lastNameCipher = await encryptPii(organisationId, input.lastName);
  const emailCipher = await encryptPii(organisationId, input.email);
  const phoneCipher =
    input.phone === undefined || input.phone === ""
      ? null
      : await encryptPii(organisationId, input.phone);

  try {
    await db
      .update(guests)
      .set({
        firstName: input.firstName,
        lastNameCipher,
        emailCipher,
        emailHash: newEmailHash,
        phoneCipher,
        updatedAt: new Date(),
      })
      .where(and(eq(guests.id, guestId), eq(guests.organisationId, organisationId)));
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: "email-taken" };
    }
    throw err;
  }

  await audit.log({
    organisationId,
    actorUserId,
    action: "guest.contact_updated",
    targetType: "guest",
    targetId: guestId,
    metadata: { emailChanged: existing.emailHash !== newEmailHash },
  });

  return { ok: true };
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
