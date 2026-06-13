// One-off backfill: populate guests.phone_hash for rows that have a
// phone_cipher but no phone_hash yet (i.e. created before the phone-hash
// column existed). Idempotent and resumable — re-running only touches rows
// still missing a hash. Decryption is per-org, so we hash with the same
// hashForLookup(value,"phone") that new writes use.
//
// Run once after migration 0050 (locally + in production). PII-safe: the
// plaintext phone is only held transiently to compute the HMAC; nothing is
// logged but ids + a count.

import "server-only";

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { guests } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import { decryptPii, hashForLookup, type Ciphertext } from "@/lib/security/crypto";

export type BackfillResult = { scanned: number; updated: number };

export async function backfillGuestPhoneHash(batchSize = 500): Promise<BackfillResult> {
  const db = adminDb();
  let scanned = 0;
  let updated = 0;

  // Page by id so a large table doesn't load at once; we always re-query
  // the "needs hash" predicate so completed rows drop out of the next page.
  for (;;) {
    const rows = await db
      .select({
        id: guests.id,
        organisationId: guests.organisationId,
        phoneCipher: guests.phoneCipher,
      })
      .from(guests)
      .where(and(isNotNull(guests.phoneCipher), isNull(guests.phoneHash)))
      .limit(batchSize);

    if (rows.length === 0) break;
    scanned += rows.length;

    for (const row of rows) {
      if (!row.phoneCipher) continue;
      const phone = await decryptPii(row.organisationId, row.phoneCipher as Ciphertext);
      const phoneHash = hashForLookup(phone, "phone");
      await db.update(guests).set({ phoneHash }).where(eq(guests.id, row.id));
      updated++;
    }

    // Safety valve: if a row's cipher failed to produce a hash we'd loop
    // forever. updated should equal rows.length each pass; if it didn't,
    // stop rather than spin.
    if (updated < scanned) break;
  }

  return { scanned, updated };
}
