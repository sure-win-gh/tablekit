// Read queries for v1 guest endpoints.
//
// Always scoped by organisation_id (the auth wrapper resolves this
// from the API key). Cursor pagination orders by (created_at desc,
// id desc) so newest guests come first with deterministic tie-break.
//
// PII model:
//   • List endpoint returns minimal projection — id, first_name
//     (plaintext column), created_at, plus the email_hash so a
//     caller can match against a hash they already have. Skips
//     last_name, email, phone decryption (per-row crypto cost +
//     keeps the largest blob off the list response).
//   • Detail endpoint decrypts the full PII set. The API key holder
//     is the legitimate audience for their own org's guest data.

import "server-only";

import { and, desc, eq, lt, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/lib/db/schema";
import { guests } from "@/lib/db/schema";
import { type Ciphertext, decryptPii } from "@/lib/security/crypto";

import { type Cursor, encodeCursor } from "./cursor";

type Db = NodePgDatabase<typeof schema>;

export type ListGuestsArgs = {
  organisationId: string;
  cursor?: Cursor<string> | null | undefined;
  limit: number;
};

export type SerialisedGuestSummary = {
  id: string;
  first_name: string;
  email_hash: string;
  created_at: string;
};

export type SerialisedGuestDetail = SerialisedGuestSummary & {
  last_name: string;
  email: string;
  phone: string | null;
  email_invalid: boolean;
  phone_invalid: boolean;
  marketing_consent_email_at: string | null;
  marketing_consent_sms_at: string | null;
  // Per-venue unsubscribe surfaces — operators integrating with
  // their own email systems often want to honour these.
  email_unsubscribed_venues: string[];
  sms_unsubscribed_venues: string[];
};

export type ListGuestsResult = {
  data: SerialisedGuestSummary[];
  next_cursor: string | null;
};

export async function listGuests(db: Db, args: ListGuestsArgs): Promise<ListGuestsResult> {
  const conds = [eq(guests.organisationId, args.organisationId)];
  if (args.cursor) {
    conds.push(
      or(
        lt(guests.createdAt, new Date(args.cursor.k)),
        and(eq(guests.createdAt, new Date(args.cursor.k)), lt(guests.id, args.cursor.i)),
      )!,
    );
  }

  const rows = await db
    .select({
      id: guests.id,
      firstName: guests.firstName,
      emailHash: guests.emailHash,
      createdAt: guests.createdAt,
    })
    .from(guests)
    .where(and(...conds))
    .orderBy(desc(guests.createdAt), desc(guests.id))
    .limit(args.limit + 1);

  const hasMore = rows.length > args.limit;
  const page = hasMore ? rows.slice(0, args.limit) : rows;
  const last = page[page.length - 1];
  const next_cursor =
    hasMore && last ? encodeCursor({ k: last.createdAt.toISOString(), i: last.id }) : null;

  return {
    data: page.map((r) => ({
      id: r.id,
      first_name: r.firstName,
      email_hash: r.emailHash,
      created_at: r.createdAt.toISOString(),
    })),
    next_cursor,
  };
}

export async function getGuest(
  db: Db,
  args: { organisationId: string; id: string },
): Promise<SerialisedGuestDetail | null> {
  const [row] = await db
    .select()
    .from(guests)
    .where(and(eq(guests.id, args.id), eq(guests.organisationId, args.organisationId)))
    .limit(1);
  if (!row) return null;

  const [lastName, email, phone] = await Promise.all([
    decryptPii(args.organisationId, row.lastNameCipher as Ciphertext),
    decryptPii(args.organisationId, row.emailCipher as Ciphertext),
    row.phoneCipher
      ? decryptPii(args.organisationId, row.phoneCipher as Ciphertext)
      : Promise.resolve(null),
  ]);

  return {
    id: row.id,
    first_name: row.firstName,
    last_name: lastName,
    email,
    email_hash: row.emailHash,
    phone,
    email_invalid: row.emailInvalid,
    phone_invalid: row.phoneInvalid,
    marketing_consent_email_at: row.marketingConsentEmailAt?.toISOString() ?? null,
    marketing_consent_sms_at: row.marketingConsentSmsAt?.toISOString() ?? null,
    email_unsubscribed_venues: row.emailUnsubscribedVenues,
    sms_unsubscribed_venues: row.smsUnsubscribedVenues,
    created_at: row.createdAt.toISOString(),
  };
}
