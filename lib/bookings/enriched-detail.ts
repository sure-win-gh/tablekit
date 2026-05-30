// Single point that turns raw `bookings ⋈ guests` rows into the
// seating-moment enrichment shape. Decrypts guests.notes_cipher and
// bookings.dietary_notes_cipher, and counts prior realised visits
// per booking — both with the same RLS-scoped Db handle the caller
// already used to read the rows.

import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { getPriorRealisedVisitsBatch } from "@/lib/guests/visit-history";
import { decryptPii, type Ciphertext } from "@/lib/security/crypto";
import type * as schema from "@/lib/db/schema";

import type { GuestEnrichment } from "./detail";

type Db = NodePgDatabase<typeof schema>;

// Caller-supplied row shape — minimal so any of bookings list /
// timeline / floor-plan can pass their existing rows in. `id` is the
// booking id; `startAt` is the booking's start used to bound "prior".
export type EnrichmentInput = {
  id: string;
  guestId: string;
  startAt: Date;
  guestNotesCipher: string | null;
  dietaryNotesCipher: string | null;
  guestTags: string[];
  highChairs: number;
};

export async function enrichBookingsForDisplay(
  db: Db,
  orgId: string,
  rows: EnrichmentInput[],
): Promise<Map<string, GuestEnrichment>> {
  if (rows.length === 0) return new Map();

  const counts = await getPriorRealisedVisitsBatch(
    db,
    rows.map((r) => ({ bookingId: r.id, guestId: r.guestId, startAt: r.startAt })),
  );

  // Decrypt in parallel — both columns are short strings and the GCM
  // cost is tiny per call, but Promise.all keeps the page render
  // latency flat when an operator has 80 bookings on screen.
  const enriched = await Promise.all(
    rows.map(async (r) => {
      const [guestNotes, dietaryNotes] = await Promise.all([
        r.guestNotesCipher
          ? decryptPii(orgId, r.guestNotesCipher as Ciphertext)
          : Promise.resolve(null),
        r.dietaryNotesCipher
          ? decryptPii(orgId, r.dietaryNotesCipher as Ciphertext)
          : Promise.resolve(null),
      ]);
      const entry: GuestEnrichment = {
        guestTags: r.guestTags,
        guestNotes,
        dietaryNotes,
        highChairs: r.highChairs,
        priorVisits: counts.get(r.id) ?? 0,
      };
      return [r.id, entry] as const;
    }),
  );

  return new Map(enriched);
}
