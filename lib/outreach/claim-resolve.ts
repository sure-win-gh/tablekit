// Token resolve + accept for outreach claim links.
//
// Mirrors lib/auth/invitations.ts in shape so the security posture
// matches what `@security-reviewer` already approved for invites: token
// hashes only, single-flip on accept, idempotent under concurrent
// double-click, "no live invite" returns null rather than a structured
// reason (anti-enum signal — attackers fishing token URLs see one
// generic 404 regardless of expired/claimed/missing).
//
// Differences from invitations.ts:
//   • There's no membership to add to an existing org — we're handing
//     the WHOLE org over to its first owner. Unclaimed orgs have zero
//     memberships by construction (see lib/outreach/create-claimable.ts).
//   • Two timestamps flip on accept: outreach_claims.claimed_at AND
//     organisations.claimed_at, plus the owner membership insert. All
//     three in one transaction.

import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { memberships, organisations, outreachClaims, users } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import { hashClaimToken } from "./claim-token";

export type LiveClaim = {
  id: string;
  organisationId: string;
  organisationName: string;
  prospectEmail: string;
  expiresAt: Date;
  // Counts surfaced on the preview page so the prospect sees what
  // they're claiming. Cheap one-shot subqueries; no PII.
  tableCount: number;
  serviceCount: number;
  // Comma-joined list "Lunch, Dinner" — purely cosmetic.
  serviceNames: string;
};

export async function resolveClaim(token: string): Promise<LiveClaim | null> {
  const tokenHash = hashClaimToken(token);
  const db = adminDb();

  const rows = await db.execute<{
    id: string;
    organisation_id: string;
    organisation_name: string;
    prospect_email: string;
    expires_at: Date;
    table_count: string;
    service_count: string;
    service_names: string | null;
  }>(sql`
    select c.id,
           c.organisation_id,
           o.name as organisation_name,
           c.prospect_email,
           c.expires_at,
           (select count(*) from tables   t where t.organisation_id = o.id) as table_count,
           (select count(*) from services s where s.organisation_id = o.id) as service_count,
           (select string_agg(s.name, ', ' order by s.name)
              from services s where s.organisation_id = o.id) as service_names
      from outreach_claims c
      join organisations  o on o.id = c.organisation_id
     where c.token_hash = ${tokenHash}
       and c.claimed_at is null
       and o.claimed_at is null
       and c.expires_at > now()
     limit 1
  `);

  const row = rows.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    organisationId: row.organisation_id,
    organisationName: row.organisation_name,
    prospectEmail: row.prospect_email,
    expiresAt: row.expires_at,
    tableCount: Number(row.table_count),
    serviceCount: Number(row.service_count),
    serviceNames: row.service_names ?? "",
  };
}

export type AcceptClaimResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "claimed" | "missing-user" };

// Atomic accept. Re-checks live state inside the tx so a concurrent
// claim from a second tab can't double-flip the row. The membership
// insert uses on-conflict-do-nothing so a refresh after success is
// idempotent rather than a duplicate-key error.
export async function acceptClaim(input: {
  claimId: string;
  userId: string;
}): Promise<AcceptClaimResult> {
  const db = adminDb();
  return db.transaction(async (tx) => {
    const [u] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!u) return { ok: false, reason: "missing-user" } as const;

    const [claim] = await tx
      .select({
        id: outreachClaims.id,
        organisationId: outreachClaims.organisationId,
        expiresAt: outreachClaims.expiresAt,
      })
      .from(outreachClaims)
      .where(and(eq(outreachClaims.id, input.claimId), isNull(outreachClaims.claimedAt)))
      .limit(1);
    if (!claim) return { ok: false, reason: "claimed" } as const;
    if (claim.expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: "expired" } as const;
    }

    const now = new Date();
    await tx
      .update(outreachClaims)
      .set({ claimedAt: now, claimedByUserId: input.userId })
      .where(eq(outreachClaims.id, claim.id));

    await tx
      .update(organisations)
      .set({ claimedAt: now })
      .where(eq(organisations.id, claim.organisationId));

    // Plain insert (no onConflictDoNothing). Unclaimed orgs have zero
    // memberships by construction (see create-claimable.ts), so a PK
    // collision here means somebody raced a different membership write
    // into the same org — surface it rather than silently downgrade.
    await tx.insert(memberships).values({
      userId: input.userId,
      organisationId: claim.organisationId,
      role: "owner",
    });

    return { ok: true } as const;
  });
}
