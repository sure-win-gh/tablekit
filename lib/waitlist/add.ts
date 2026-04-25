// Add a walk-in to the waitlist.
//
// Phone is required (the whole point is the ready-SMS). Email is
// optional in the host UI but the underlying guests row needs an
// email_hash, so we synthesise a placeholder derived from the phone
// when none is provided. Two walk-ins giving the same phone collapse
// to the same guest record via upsertGuest's emailHash dedupe.

import "server-only";

import { z } from "zod";

import { waitlists } from "@/lib/db/schema";
import { upsertGuest } from "@/lib/guests/upsert";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export const addWaitlistInput = z.object({
  venueId: z.string().uuid(),
  partySize: z.number().int().min(1).max(50),
  firstName: z.string().trim().min(1).max(80),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9()\-\s]{7,20}$/, "Enter a valid phone number")
    .max(40),
  email: z.string().trim().toLowerCase().email().max(200).optional(),
  notes: z.string().max(200).optional(),
});

export type AddWaitlistInput = z.input<typeof addWaitlistInput>;

export type AddWaitlistResult =
  | { ok: true; waitlistId: string; guestId: string }
  | { ok: false; reason: "guest-invalid"; issues: string[] };

export async function addWaitlist(
  organisationId: string,
  actorUserId: string,
  rawInput: AddWaitlistInput,
): Promise<AddWaitlistResult> {
  const input = addWaitlistInput.parse(rawInput);

  // Synthesise a placeholder email when host didn't enter one. The
  // walk-in host UI usually only collects phone; this keeps the
  // guests schema (email_hash NOT NULL) happy without polluting the
  // upsert's dedupe contract — same phone yields the same synthetic
  // email, so a returning walk-in collapses to one guest.
  const phoneNormal = input.phone.replace(/\D+/g, "");
  const email = input.email ?? `walkin.${phoneNormal}@walkin.tablekit.local`;

  const guestR = await upsertGuest(organisationId, actorUserId, {
    firstName: input.firstName,
    email,
    phone: input.phone,
  });
  if (!guestR.ok) {
    return { ok: false, reason: "guest-invalid", issues: guestR.issues };
  }

  const db = adminDb();
  const [row] = await db
    .insert(waitlists)
    .values({
      organisationId, // overwritten by enforce_waitlists_org_id trigger
      venueId: input.venueId,
      guestId: guestR.guestId,
      partySize: input.partySize,
      ...(input.notes ? { notes: input.notes } : {}),
    })
    .returning({ id: waitlists.id });

  if (!row) throw new Error("addWaitlist: insert returned no row");

  await audit.log({
    organisationId,
    actorUserId,
    action: "waitlist.added",
    targetType: "waitlist",
    targetId: row.id,
    metadata: { venueId: input.venueId, partySize: input.partySize, guestId: guestR.guestId },
  });

  return { ok: true, waitlistId: row.id, guestId: guestR.guestId };
}
