// setMarketingConsent — flip the per-channel consent timestamp for a
// guest. `consenting=true` writes now(); `consenting=false` clears the
// timestamp (the audit log records the opt-out moment).
//
// For the email channel we also mirror to the legacy
// `marketing_consent_at` column for one release per the forward-only
// migration rule. SMS has no legacy mirror — that column was always
// email-flavoured.

import "server-only";

import { and, eq } from "drizzle-orm";

import { guests } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export type MarketingChannel = "email" | "sms";

export type SetMarketingConsentInput = {
  organisationId: string;
  actorUserId: string | null;
  guestId: string;
  channel: MarketingChannel;
  consenting: boolean;
};

export type SetMarketingConsentResult =
  | { ok: true }
  | { ok: false; reason: "guest-not-found" };

export async function setMarketingConsent(
  input: SetMarketingConsentInput,
): Promise<SetMarketingConsentResult> {
  const db = adminDb();

  const [existing] = await db
    .select({ id: guests.id })
    .from(guests)
    .where(and(eq(guests.id, input.guestId), eq(guests.organisationId, input.organisationId)))
    .limit(1);
  if (!existing) return { ok: false, reason: "guest-not-found" };

  const ts = input.consenting ? new Date() : null;
  const patch: {
    marketingConsentAt?: Date | null;
    marketingConsentEmailAt?: Date | null;
    marketingConsentSmsAt?: Date | null;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (input.channel === "email") {
    patch.marketingConsentEmailAt = ts;
    patch.marketingConsentAt = ts; // legacy mirror
  } else {
    patch.marketingConsentSmsAt = ts;
  }

  await db
    .update(guests)
    .set(patch)
    .where(and(eq(guests.id, input.guestId), eq(guests.organisationId, input.organisationId)));

  await audit.log({
    organisationId: input.organisationId,
    actorUserId: input.actorUserId,
    action: `guest.consent.${input.channel}.${input.consenting ? "on" : "off"}`,
    targetType: "guest",
    targetId: input.guestId,
  });

  return { ok: true };
}
