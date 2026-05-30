// Update editable booking details — notes + party size.
//
// Both fields are direct UPDATEs on `bookings`. No state-machine
// implications: notes is free-text, party_size is constrained at
// the DB level (>= 1) and clamped at 20 here to match the create
// path. We don't re-run availability on a party-size change — an
// operator deliberately bumping a 2-cover booking to 6 on a 4-cap
// table is intentional and the right call lives in their judgment;
// the floor-plan-visual phase can flag a capacity violation when
// it ships.

import "server-only";

import { and, eq } from "drizzle-orm";

import { bookings } from "@/lib/db/schema";
import { encryptPii } from "@/lib/security/crypto";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

const MAX_NOTES = 500;
const MIN_PARTY = 1;
const MAX_PARTY = 20;
const MAX_DIETARY_NOTES = 500;
const MIN_HIGHCHAIRS = 0;
const MAX_HIGHCHAIRS = 20;

export type UpdateBookingDetailsInput = {
  organisationId: string;
  actorUserId: string;
  bookingId: string;
  // undefined = leave alone; null = clear; string = set.
  notes?: string | null | undefined;
  // undefined = leave alone.
  partySize?: number | undefined;
  // undefined = leave alone.
  highChairs?: number | undefined;
  // undefined = leave alone; null = clear; string = set (will be
  // encrypted before write).
  dietaryNotes?: string | null | undefined;
};

export type UpdateBookingDetailsResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "invalid-input"; issues?: string[] };

export async function updateBookingDetails(
  input: UpdateBookingDetailsInput,
): Promise<UpdateBookingDetailsResult> {
  const issues: string[] = [];
  if (typeof input.notes === "string" && input.notes.length > MAX_NOTES) {
    issues.push(`notes: must be ≤ ${MAX_NOTES} characters`);
  }
  if (input.partySize !== undefined) {
    if (!Number.isInteger(input.partySize)) issues.push("partySize: must be an integer");
    else if (input.partySize < MIN_PARTY || input.partySize > MAX_PARTY) {
      issues.push(`partySize: must be ${MIN_PARTY}–${MAX_PARTY}`);
    }
  }
  if (input.highChairs !== undefined) {
    if (!Number.isInteger(input.highChairs)) issues.push("highChairs: must be an integer");
    else if (input.highChairs < MIN_HIGHCHAIRS || input.highChairs > MAX_HIGHCHAIRS) {
      issues.push(`highChairs: must be ${MIN_HIGHCHAIRS}–${MAX_HIGHCHAIRS}`);
    }
  }
  if (typeof input.dietaryNotes === "string" && input.dietaryNotes.length > MAX_DIETARY_NOTES) {
    issues.push(`dietaryNotes: must be ≤ ${MAX_DIETARY_NOTES} characters`);
  }
  if (
    input.notes === undefined &&
    input.partySize === undefined &&
    input.highChairs === undefined &&
    input.dietaryNotes === undefined
  ) {
    issues.push("nothing to update");
  }
  if (issues.length > 0) return { ok: false, reason: "invalid-input", issues };

  const db = adminDb();

  const [existing] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.organisationId, input.organisationId)))
    .limit(1);
  if (!existing) return { ok: false, reason: "not-found" };

  const patch: {
    notes?: string | null;
    partySize?: number;
    highChairs?: number;
    dietaryNotesCipher?: string | null;
  } = {};
  if (input.notes !== undefined) {
    patch.notes = input.notes === null || input.notes.trim() === "" ? null : input.notes;
  }
  if (input.partySize !== undefined) {
    patch.partySize = input.partySize;
  }
  if (input.highChairs !== undefined) {
    patch.highChairs = input.highChairs;
  }
  if (input.dietaryNotes !== undefined) {
    // Article 9 special-category data — never written plaintext.
    patch.dietaryNotesCipher =
      input.dietaryNotes === null || input.dietaryNotes.trim() === ""
        ? null
        : await encryptPii(input.organisationId, input.dietaryNotes);
  }

  await db
    .update(bookings)
    .set(patch)
    .where(
      and(eq(bookings.id, input.bookingId), eq(bookings.organisationId, input.organisationId)),
    );

  await audit.log({
    organisationId: input.organisationId,
    actorUserId: input.actorUserId,
    action: "booking.transitioned",
    targetType: "booking",
    targetId: input.bookingId,
    metadata: {
      kind: "details-update",
      notesUpdated: input.notes !== undefined,
      partySizeUpdated: input.partySize !== undefined,
      highChairsUpdated: input.highChairs !== undefined,
      dietaryNotesUpdated: input.dietaryNotes !== undefined,
    },
  });

  return { ok: true };
}
