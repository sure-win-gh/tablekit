// Updates the per-guest "sticky" fields surfaced at the seating
// moment: free-form tags + an encrypted notes blob for allergies +
// accessibility needs that persist across visits.
//
// Tags live plaintext in guests.tags (text[]); they're operator-
// curated and not guest PII (caller validates). Notes go into
// guests.notes_cipher via envelope encryption — special-category
// data under UK GDPR Art. 9.

import "server-only";

import { and, eq } from "drizzle-orm";

import { guests } from "@/lib/db/schema";
import { encryptPii } from "@/lib/security/crypto";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export type UpdateGuestProfileInput = {
  organisationId: string;
  actorUserId: string;
  guestId: string;
  tags: string[];
  // null clears the notes_cipher column; string sets it (after encrypt).
  notes: string | null;
};

export type UpdateGuestProfileResult = { ok: true } | { ok: false; reason: "not-found" };

export async function updateGuestProfile(
  input: UpdateGuestProfileInput,
): Promise<UpdateGuestProfileResult> {
  const db = adminDb();

  const [existing] = await db
    .select({ id: guests.id })
    .from(guests)
    .where(and(eq(guests.id, input.guestId), eq(guests.organisationId, input.organisationId)))
    .limit(1);
  if (!existing) return { ok: false, reason: "not-found" };

  const notesCipher =
    input.notes === null ? null : await encryptPii(input.organisationId, input.notes);

  await db
    .update(guests)
    .set({ tags: input.tags, notesCipher, updatedAt: new Date() })
    .where(and(eq(guests.id, input.guestId), eq(guests.organisationId, input.organisationId)));

  await audit.log({
    organisationId: input.organisationId,
    actorUserId: input.actorUserId,
    action: "guest.updated",
    targetType: "guest",
    targetId: input.guestId,
    metadata: { kind: "profile-update", tagCount: input.tags.length, notesUpdated: true },
  });

  return { ok: true };
}
