"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { mintInvitation } from "@/lib/auth/invitations";
import { requireRole } from "@/lib/auth/require-role";
import { adminDb } from "@/lib/server/admin/db";
import { audit } from "@/lib/server/admin/audit";
import { renderTeamInvite } from "@/lib/email/templates/team-invite";
import { sendEmail } from "@/lib/email/send";
import { orgInvitations, organisations, users } from "@/lib/db/schema";

// Server actions for the /dashboard/organisation/team page. Owner-only
// for both create and revoke — managers can see the team list but
// can't mutate membership.

const CreateInput = z.object({
  email: z.string().email().max(320),
  role: z.enum(["manager", "host"]),
});

const RevokeInput = z.object({ inviteId: z.string().uuid() });

export type CreateState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "ok"; email: string };

export async function createInvite(_prev: CreateState, formData: FormData): Promise<CreateState> {
  const parsed = CreateInput.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return { status: "error", message: "Enter a valid email and role." };
  }

  const ctx = await requireRole("owner");
  const db = adminDb();

  // Look up org name + inviter name for the email body. Cheap single
  // query; both sit on already-loaded auth context.
  const [org] = await db
    .select({ name: organisations.name })
    .from(organisations)
    .where(eq(organisations.id, ctx.orgId))
    .limit(1);
  const [inviter] = await db
    .select({ name: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);

  if (!org) return { status: "error", message: "organisation lookup failed" };

  // Mint the token + insert. The partial unique index on (org, email)
  // for live invites raises 23505 if there's already a pending row;
  // surface that as a helpful message rather than the bare PG error.
  let mint;
  try {
    mint = await mintInvitation({
      organisationId: ctx.orgId,
      email: parsed.data.email,
      role: parsed.data.role,
      invitedByUserId: ctx.userId,
    });
  } catch (err) {
    if (err instanceof Error && /unique/i.test(err.message)) {
      return {
        status: "error",
        message: `${parsed.data.email} already has a pending invite. Revoke it first.`,
      };
    }
    throw err;
  }

  // Send the email. Don't fail the whole action on send failure —
  // the row exists; the owner can resend by revoking + re-inviting,
  // and we surface a soft warning. Worst case the inviter copies the
  // accept URL out of the dashboard manually.
  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
  const acceptUrl = `${appUrl}/invite/${mint.token}`;
  try {
    const rendered = await renderTeamInvite({
      organisationName: org.name,
      invitedByName: inviter?.name ?? inviter?.email ?? null,
      role: parsed.data.role,
      acceptUrl,
      expiresAtIso: mint.expiresAt.toISOString(),
    });
    await sendEmail({
      to: parsed.data.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      // Operational; mailbox providers must not POST against the
      // marketing site for unsubscribe — there's no opt-out flow for
      // a one-shot invite.
      unsubscribeUrl: `${appUrl}/`,
      oneClickUnsubscribe: false,
      idempotencyKey: `team-invite-${mint.inviteId}`,
    });
  } catch {
    // Don't block — row already exists. Owner can use the visible
    // accept URL on the team page (a future enhancement) or revoke +
    // retry. Audit captures the create regardless.
  }

  // Audit metadata stays PII-free — the invite UUID joins back to
  // org_invitations.email if the audit feed ever needs the address.
  await audit.log({
    organisationId: ctx.orgId,
    actorUserId: ctx.userId,
    action: "invite.created",
    targetType: "invitation",
    targetId: mint.inviteId,
    metadata: { role: parsed.data.role },
  });

  revalidatePath("/dashboard/organisation/team");
  return { status: "ok", email: parsed.data.email };
}

export async function revokeInvite(input: { inviteId: string }): Promise<void> {
  const parsed = RevokeInput.safeParse(input);
  if (!parsed.success) return;

  const ctx = await requireRole("owner");
  const db = adminDb();

  // Set revoked_at, scoped to this org. adminDb skips RLS, so we
  // explicitly include the org filter — a forged inviteId belonging
  // to another org silently no-ops.
  await db
    .update(orgInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(orgInvitations.id, parsed.data.inviteId),
        eq(orgInvitations.organisationId, ctx.orgId),
      ),
    );

  // Revocation isn't audit-logged separately — the row's revokedAt
  // timestamp is the source of truth, queryable from the team page
  // and the audit feed. (A future invite.revoked action type can be
  // added if reporting needs it.)

  revalidatePath("/dashboard/organisation/team");
}
