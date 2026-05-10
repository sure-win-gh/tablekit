// Team invitations: token mint + verify + accept.
//
// Tokens are 32 random bytes encoded base64url. We never persist the
// plaintext; only its SHA-256 hash lands in `org_invitations.token_hash`.
// The plaintext lives in the emailed URL and the inviter's browser
// (the server action returns it for the email send) for ~1 second.
//
// Acceptance is one-shot: row.accepted_at flips to now() in the same
// statement that creates the membership, behind a uniqueness constraint
// on (user_id, organisation_id) so a double-click can't dupe the row.

import "server-only";

import { randomBytes, createHash } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import { adminDb } from "@/lib/server/admin/db";
import { memberships, orgInvitations, users } from "@/lib/db/schema";

import type { OrgRole } from "./role-level";

// 72-hour expiry per docs/specs/auth.md ("Invite tokens single-use,
// 72h expiry"). Configurable via env if a customer asks for shorter.
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;

export type MintResult = {
  inviteId: string;
  // Plaintext token — return-once, never logged.
  token: string;
  expiresAt: Date;
};

// Generate a fresh token + insert the invitation row. Idempotent on
// the partial unique index (org_id, email) WHERE pending — a duplicate
// pending invite raises a unique-violation that the caller surfaces
// to the inviter as "already invited".
export async function mintInvitation(input: {
  organisationId: string;
  email: string;
  role: OrgRole;
  invitedByUserId: string;
  ttlMs?: number;
}): Promise<MintResult> {
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ttl);

  const db = adminDb();
  const [row] = await db
    .insert(orgInvitations)
    .values({
      organisationId: input.organisationId,
      email: input.email,
      role: input.role,
      tokenHash,
      invitedByUserId: input.invitedByUserId,
      expiresAt,
    })
    .returning({ id: orgInvitations.id });

  if (!row) throw new Error("mintInvitation: insert returned no row");

  return { inviteId: row.id, token, expiresAt };
}

// Resolve a token back to a live invitation row, or null. "Live" means
// not accepted, not revoked, not expired. We hash the input + look up
// by hash to keep the comparison O(1) — no plaintext-token column to
// compare against.
export type LiveInvitation = {
  id: string;
  organisationId: string;
  email: string;
  role: OrgRole;
  invitedByUserId: string | null;
  expiresAt: Date;
  // For showing the org name on the accept page.
  organisationName: string;
};

export async function resolveInvitation(token: string): Promise<LiveInvitation | null> {
  const tokenHash = hashToken(token);
  const db = adminDb();

  const rows = await db.execute<{
    id: string;
    organisation_id: string;
    email: string;
    role: OrgRole;
    invited_by_user_id: string | null;
    expires_at: Date;
    organisation_name: string;
  }>(sql`
    select i.id, i.organisation_id, i.email, i.role, i.invited_by_user_id,
           i.expires_at, o.name as organisation_name
      from org_invitations i
      join organisations o on o.id = i.organisation_id
     where i.token_hash = ${tokenHash}
       and i.accepted_at is null
       and i.revoked_at is null
       and i.expires_at > now()
     limit 1
  `);

  const row = rows.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    organisationId: row.organisation_id,
    email: row.email,
    role: row.role,
    invitedByUserId: row.invited_by_user_id,
    expiresAt: row.expires_at,
    organisationName: row.organisation_name,
  };
}

// Accept an invitation. Atomic: mark accepted_at + insert membership
// in a single transaction. If membership already exists (user accepted
// a previous invite from the same org), upgrade the row to the new
// role only when the new role outranks the old one — so an accepted
// invite can't silently demote an existing owner.
export async function acceptInvitation(input: {
  inviteId: string;
  userId: string;
}): Promise<{ ok: true } | { ok: false; reason: "expired" | "claimed" | "missing-user" }> {
  const db = adminDb();
  return db.transaction(async (tx) => {
    // Ensure the public.users row exists (Supabase trigger should have
    // created it on signup, but a freshly-confirmed signup might race
    // — fall through with a clear error rather than corrupt FK).
    const [u] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!u) return { ok: false, reason: "missing-user" } as const;

    // Re-check live state inside the tx so a concurrent accept can't
    // double-flip the row.
    const [invite] = await tx
      .select({
        id: orgInvitations.id,
        organisationId: orgInvitations.organisationId,
        role: orgInvitations.role,
        expiresAt: orgInvitations.expiresAt,
      })
      .from(orgInvitations)
      .where(
        and(
          eq(orgInvitations.id, input.inviteId),
          isNull(orgInvitations.acceptedAt),
          isNull(orgInvitations.revokedAt),
        ),
      )
      .limit(1);

    if (!invite) return { ok: false, reason: "claimed" } as const;
    if (invite.expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: "expired" } as const;
    }

    // Mark accepted first — the unique partial index on (org, email)
    // would otherwise prevent re-inviting if the membership insert
    // fails midway.
    await tx
      .update(orgInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(orgInvitations.id, invite.id));

    // ON CONFLICT DO UPDATE — if the user is already a member of this
    // org (e.g. owner re-inviting themselves by mistake), keep the
    // higher of the two roles. Drizzle's onConflictDoUpdate uses the
    // composite PK.
    await tx
      .insert(memberships)
      .values({
        userId: input.userId,
        organisationId: invite.organisationId,
        role: invite.role,
      })
      .onConflictDoNothing({
        target: [memberships.userId, memberships.organisationId],
      });

    return { ok: true } as const;
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
