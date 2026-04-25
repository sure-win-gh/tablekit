// upsertGuest — the only sanctioned way to create or reuse a guest row.
//
// Contract:
//   - encrypt last name, email, phone (when given) with the org's DEK
//   - hash the email so `(org_id, email_hash)` does the dedup
//   - on conflict, update optional fields ONLY where the caller
//     supplied a new non-null value (no blanking a phone by omitting it)
//   - audit-log `guest.created` vs `guest.reused` vs `guest.updated` so
//     a manager can reconstruct who booked first
//
// Uses adminDb() because there are no INSERT policies on guests for
// the authenticated role (RLS enforces read-only on the widget / host
// side — writes route through server actions). Same pattern as venue
// creation in the venues phase.

import "server-only";

import { and, eq } from "drizzle-orm";

import { guests } from "@/lib/db/schema";
import { encryptPii, hashForLookup } from "@/lib/security/crypto";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { upsertGuestInput, type UpsertGuestInput } from "./schema";

export type UpsertGuestResult =
  | { ok: true; guestId: string; reused: boolean }
  | { ok: false; reason: "invalid-input"; issues: string[] };

export async function upsertGuest(
  organisationId: string,
  actorUserId: string | null,
  raw: unknown,
): Promise<UpsertGuestResult> {
  const parsed = upsertGuestInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid-input",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const input: UpsertGuestInput = parsed.data;

  const db = adminDb();
  const emailHash = hashForLookup(input.email, "email");

  // Look up an existing non-erased guest under this org.
  const [existing] = await db
    .select({
      id: guests.id,
      phoneCipher: guests.phoneCipher,
      marketingConsentAt: guests.marketingConsentAt,
    })
    .from(guests)
    .where(and(eq(guests.organisationId, organisationId), eq(guests.emailHash, emailHash)))
    .limit(1);

  if (existing) {
    // Reuse. Patch the columns the caller supplied a new non-null
    // value for.
    const patch: {
      phoneCipher?: string;
      marketingConsentAt?: Date;
      firstName?: string;
      lastNameCipher?: string;
    } = {};

    if (input.phone !== undefined && existing.phoneCipher === null) {
      patch.phoneCipher = await encryptPii(organisationId, input.phone);
    }
    if (input.marketingConsentAt && existing.marketingConsentAt === null) {
      patch.marketingConsentAt = input.marketingConsentAt;
    }
    // First name and last name: always refresh to the caller's version
    // — the caller is the source of truth (widget signup, host edit).
    // Skipping an update would let stale display values linger.
    patch.firstName = input.firstName;
    patch.lastNameCipher = await encryptPii(organisationId, input.lastName);

    await db.update(guests).set(patch).where(eq(guests.id, existing.id));

    await audit.log({
      organisationId,
      actorUserId,
      action: "guest.reused",
      targetType: "guest",
      targetId: existing.id,
    });

    return { ok: true, guestId: existing.id, reused: true };
  }

  // Fresh insert.
  const lastNameCipher = await encryptPii(organisationId, input.lastName);
  const emailCipher = await encryptPii(organisationId, input.email);
  const phoneCipher = input.phone ? await encryptPii(organisationId, input.phone) : null;

  const [inserted] = await db
    .insert(guests)
    .values({
      organisationId,
      firstName: input.firstName,
      lastNameCipher,
      emailCipher,
      emailHash,
      phoneCipher,
      marketingConsentAt: input.marketingConsentAt ?? null,
    })
    .returning({ id: guests.id });

  if (!inserted) {
    // Unreachable unless the DB is in an impossible state — insert
    // without returning a row.
    throw new Error("lib/guests/upsert.ts: insert returned no row");
  }

  await audit.log({
    organisationId,
    actorUserId,
    action: "guest.created",
    targetType: "guest",
    targetId: inserted.id,
  });

  return { ok: true, guestId: inserted.id, reused: false };
}
