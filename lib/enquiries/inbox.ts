// Operator inbox read queries.
//
// SELECTs run via withUser so the `enquiries_member_read` RLS policy
// scopes the result to the caller's organisations. Detail loads also
// decrypt the parsed JSON + draft body server-side; the operator is
// the legitimate audience for that plaintext (their own org's row).
//
// suggested_slots is plaintext jsonb already — no decrypt needed.

import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/lib/db/schema";
import { enquiries } from "@/lib/db/schema";
import { type Ciphertext, decryptPii } from "@/lib/security/crypto";

import type { ParsedEnquiry, SuggestedSlot } from "./types";
import { type EnquiryStatus, ParsedEnquirySchema } from "./types";

type Db = NodePgDatabase<typeof schema>;

// Buckets shown in the inbox UI. Keeps three "things you might care
// about" lanes off one column rather than forcing the operator to
// remember the full status enum.
//
//   needs_action — drafts ready to send + parse failures + still-
//                  received (cron will pick up, but visible so a
//                  stuck cron is obvious).
//   replied      — already sent.
//   discarded    — auto-discarded (not_a_booking_request) plus
//                  operator-dismissed.
export type InboxBucket = "needs_action" | "replied" | "discarded";

const BUCKET_STATUSES: Record<InboxBucket, ReadonlyArray<EnquiryStatus>> = {
  needs_action: ["received", "parsing", "draft_ready", "failed"],
  replied: ["replied"],
  discarded: ["discarded"],
};

export type InboxRow = {
  id: string;
  status: EnquiryStatus;
  receivedAt: Date;
  repliedAt: Date | null;
  parseAttempts: number;
  hasDraft: boolean;
  // Decrypted from `subject_cipher` so the list shows what arrived.
  subject: string;
  // Decrypted preview from the parsed JSON if available, falling
  // back to "(awaiting parse)". Avoids a second decrypt of the body
  // ciphertext per row.
  preview: string;
};

export async function loadInboxList(
  db: Db,
  args: { venueId: string; bucket: InboxBucket },
): Promise<InboxRow[]> {
  const statuses = BUCKET_STATUSES[args.bucket];
  const rows = await db
    .select({
      id: enquiries.id,
      organisationId: enquiries.organisationId,
      status: enquiries.status,
      receivedAt: enquiries.receivedAt,
      repliedAt: enquiries.repliedAt,
      parseAttempts: enquiries.parseAttempts,
      subjectCipher: enquiries.subjectCipher,
      parsedCipher: enquiries.parsedCipher,
      draftReplyCipher: enquiries.draftReplyCipher,
    })
    .from(enquiries)
    .where(
      and(
        eq(enquiries.venueId, args.venueId),
        inArray(enquiries.status, statuses as unknown as string[]),
      ),
    )
    .orderBy(desc(enquiries.receivedAt))
    .limit(200);

  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      status: r.status as EnquiryStatus,
      receivedAt: r.receivedAt,
      repliedAt: r.repliedAt,
      parseAttempts: r.parseAttempts,
      hasDraft: r.draftReplyCipher !== null,
      subject: await decryptPii(r.organisationId, r.subjectCipher as Ciphertext),
      preview: await derivePreview(r.organisationId, r.parsedCipher),
    })),
  );
}

async function derivePreview(orgId: string, parsedCipher: string | null): Promise<string> {
  if (!parsedCipher) return "(awaiting parse)";
  try {
    const json = await decryptPii(orgId, parsedCipher as Ciphertext);
    const parsed = ParsedEnquirySchema.parse(JSON.parse(json));
    if (parsed.kind === "not_a_booking_request") return "Not a booking request";
    const bits: string[] = [];
    if (parsed.partySize) bits.push(`${parsed.partySize} guests`);
    if (parsed.requestedDate) bits.push(parsed.requestedDate);
    if (parsed.requestedTimeWindow) bits.push(parsed.requestedTimeWindow);
    return bits.length > 0 ? bits.join(" · ") : "(unspecified)";
  } catch {
    // Defensive: if a schema bump leaves an old row unreadable, the
    // list shouldn't blow up. The detail page will surface the real
    // error.
    return "(parse error)";
  }
}

export type EnquiryDetail = {
  id: string;
  organisationId: string;
  venueId: string;
  status: EnquiryStatus;
  receivedAt: Date;
  repliedAt: Date | null;
  parseAttempts: number;
  error: string | null;
  fromEmail: string;
  subject: string;
  body: string;
  parsed: ParsedEnquiry | null;
  suggestedSlots: ReadonlyArray<SuggestedSlot>;
  draftReply: string | null;
};

export async function loadEnquiryForOperator(
  db: Db,
  args: { enquiryId: string; venueId: string },
): Promise<EnquiryDetail | null> {
  const [row] = await db
    .select()
    .from(enquiries)
    .where(and(eq(enquiries.id, args.enquiryId), eq(enquiries.venueId, args.venueId)))
    .limit(1);
  if (!row) return null;

  const orgId = row.organisationId;
  const [fromEmail, subject, body, parsedJson, draftReply] = await Promise.all([
    decryptPii(orgId, row.fromEmailCipher as Ciphertext),
    decryptPii(orgId, row.subjectCipher as Ciphertext),
    decryptPii(orgId, row.bodyCipher as Ciphertext),
    row.parsedCipher ? decryptPii(orgId, row.parsedCipher as Ciphertext) : Promise.resolve(null),
    row.draftReplyCipher
      ? decryptPii(orgId, row.draftReplyCipher as Ciphertext)
      : Promise.resolve(null),
  ]);

  let parsed: ParsedEnquiry | null = null;
  if (parsedJson) {
    try {
      parsed = ParsedEnquirySchema.parse(JSON.parse(parsedJson));
    } catch {
      parsed = null;
    }
  }

  return {
    id: row.id,
    organisationId: row.organisationId,
    venueId: row.venueId,
    status: row.status as EnquiryStatus,
    receivedAt: row.receivedAt,
    repliedAt: row.repliedAt,
    parseAttempts: row.parseAttempts,
    error: row.error,
    fromEmail,
    subject,
    body,
    parsed,
    suggestedSlots: (row.suggestedSlots as SuggestedSlot[] | null) ?? [],
    draftReply,
  };
}
