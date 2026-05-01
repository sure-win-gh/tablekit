// Operator-initiated full guest export — CSV + JSON.
//
// Spec: docs/specs/import-export.md (Export AC #3 — encrypted PII
// columns are decrypted in the export, the owning org has the right
// to see their own data). Decryption flows through decryptPii per
// cell — this module never touches the wrapped DEK directly. RLS
// scopes the SELECT via the `withUser` caller; we additionally filter
// erased rows so we never decrypt a tombstoned cipher.
//
// Returned shape is a plain JS object — the writer (CSV or JSON
// route handler) decides presentation. Numbers stay numeric so the
// CSV formula-injection guard in lib/reports/csv.ts knows not to
// quote them.

import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/lib/db/schema";
import { guests } from "@/lib/db/schema";
import { type CsvColumn, toCsv } from "@/lib/reports/csv";
import { type Ciphertext, decryptPii } from "@/lib/security/crypto";

type Db = NodePgDatabase<typeof schema>;

export type ExportedGuest = {
  guestId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  marketingConsentAt: Date | null;
  emailInvalid: boolean;
  phoneInvalid: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export async function loadGuestsForExport(db: Db, orgId: string): Promise<ExportedGuest[]> {
  const rows = await db
    .select({
      id: guests.id,
      firstName: guests.firstName,
      lastNameCipher: guests.lastNameCipher,
      emailCipher: guests.emailCipher,
      phoneCipher: guests.phoneCipher,
      marketingConsentAt: guests.marketingConsentAt,
      emailInvalid: guests.emailInvalid,
      phoneInvalid: guests.phoneInvalid,
      createdAt: guests.createdAt,
      updatedAt: guests.updatedAt,
    })
    .from(guests)
    // Defence-in-depth: filter explicitly by orgId. RLS on guests
    // scopes to every org the caller is a member of (a dual-org user
    // would otherwise see and attempt to decrypt the other org's
    // ciphers under this org's DEK and crash mid-export). The active
    // org for the export is the caller's session-level active org.
    .where(and(eq(guests.organisationId, orgId), isNull(guests.erasedAt)))
    .orderBy(asc(guests.createdAt));

  const out: ExportedGuest[] = [];
  for (const row of rows) {
    const lastName = await decryptPii(orgId, row.lastNameCipher as Ciphertext);
    const email = await decryptPii(orgId, row.emailCipher as Ciphertext);
    const phone = row.phoneCipher ? await decryptPii(orgId, row.phoneCipher as Ciphertext) : null;
    out.push({
      guestId: row.id,
      firstName: row.firstName,
      lastName,
      email,
      phone,
      marketingConsentAt: row.marketingConsentAt,
      emailInvalid: row.emailInvalid,
      phoneInvalid: row.phoneInvalid,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
  return out;
}

export const guestsCsvColumns: CsvColumn<ExportedGuest>[] = [
  { header: "guest_id", value: (r) => r.guestId },
  { header: "first_name", value: (r) => r.firstName },
  { header: "last_name", value: (r) => r.lastName },
  { header: "email", value: (r) => r.email },
  { header: "phone", value: (r) => r.phone },
  { header: "marketing_consent_at", value: (r) => r.marketingConsentAt },
  { header: "email_invalid", value: (r) => (r.emailInvalid ? "true" : "false") },
  { header: "phone_invalid", value: (r) => (r.phoneInvalid ? "true" : "false") },
  { header: "created_at", value: (r) => r.createdAt },
  { header: "updated_at", value: (r) => r.updatedAt },
];

export function guestsToCsv(rows: ExportedGuest[]): string {
  return toCsv(rows, guestsCsvColumns);
}

export function guestsToJson(rows: ExportedGuest[]): string {
  return JSON.stringify(rows, null, 2);
}
