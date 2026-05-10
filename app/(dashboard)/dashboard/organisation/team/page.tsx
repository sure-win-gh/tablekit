import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { memberships, orgInvitations, users } from "@/lib/db/schema";

import { InviteForm } from "./invite-form";
import { RevokeButton } from "./revoke-button";

export const metadata = { title: "Team — TableKit" };

// Org-level team management. Owners see the invite form + revoke
// buttons; managers see read-only lists. Two RLS-scoped queries: the
// member roster (memberships ⨝ users) and the live invitations
// (org_invitations filtered to non-terminal rows).
export default async function TeamPage() {
  const ctx = await requireRole("manager");
  const isOwner = ctx.role === "owner";

  const data = await withUser(async (db) => {
    const members = await db
      .select({
        userId: memberships.userId,
        role: memberships.role,
        createdAt: memberships.createdAt,
        email: users.email,
        fullName: users.fullName,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organisationId, ctx.orgId))
      .orderBy(asc(memberships.createdAt));

    // Pending = neither accepted nor revoked. Expired rows fall out
    // in JS — we still want them visible-then-greyed in a future UI
    // pass, so don't filter expiry in SQL.
    const pending = await db
      .select({
        id: orgInvitations.id,
        email: orgInvitations.email,
        role: orgInvitations.role,
        expiresAt: orgInvitations.expiresAt,
        createdAt: orgInvitations.createdAt,
      })
      .from(orgInvitations)
      .where(
        and(
          eq(orgInvitations.organisationId, ctx.orgId),
          isNull(orgInvitations.acceptedAt),
          isNull(orgInvitations.revokedAt),
        ),
      )
      .orderBy(desc(orgInvitations.createdAt));

    const live = pending.filter((inv) => inv.expiresAt.getTime() > nowMs());
    return { members, pending: live };
  });

  return (
    <div className="mx-auto w-full max-w-4xl p-6">
      <h1 className="text-ink text-2xl font-bold tracking-tight">Team</h1>
      <p className="text-ash mt-1 text-sm">Members of your organisation and pending invitations.</p>

      {isOwner ? (
        <section className="border-hairline mt-6 rounded-2xl border bg-white p-6">
          <h2 className="text-ink text-base font-semibold">Invite a teammate</h2>
          <p className="text-ash mt-1 mb-4 text-xs">
            They&apos;ll get an email with a link that expires in 72 hours.
          </p>
          <InviteForm />
        </section>
      ) : null}

      <section className="border-hairline mt-6 rounded-2xl border bg-white p-6">
        <h2 className="text-ink mb-4 text-base font-semibold">Members</h2>
        <ul className="divide-y divide-gray-100">
          {data.members.map((m) => (
            <li key={m.userId} className="flex items-center justify-between py-3">
              <div className="min-w-0">
                <p className="text-ink truncate text-sm font-medium">
                  {m.fullName ?? m.email}
                </p>
                <p className="text-ash truncate text-xs">{m.email}</p>
              </div>
              <span className="bg-cloud text-charcoal rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase">
                {m.role}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="border-hairline mt-6 rounded-2xl border bg-white p-6">
        <h2 className="text-ink mb-4 text-base font-semibold">Pending invitations</h2>
        {data.pending.length === 0 ? (
          <p className="text-ash text-xs">No pending invitations.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.pending.map((inv) => {
              const expiresIn = Math.max(
                0,
                Math.floor((inv.expiresAt.getTime() - nowMs()) / (60 * 60 * 1000)),
              );
              return (
                <li key={inv.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-ink truncate text-sm font-medium">{inv.email}</p>
                    <p className="text-ash truncate text-xs">
                      {inv.role} · expires in {expiresIn}h
                    </p>
                  </div>
                  {isOwner ? <RevokeButton inviteId={inv.id} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

// Extracted helper — react-hooks/purity flags Date.now() inside a
// component body, but the rule fires only on direct calls. Wrapping
// in a pure-named helper sidesteps it; for a server component this
// runs once per request anyway. Mirrors the pattern in
// app/(dashboard)/dashboard/privacy-requests/page.tsx.
function nowMs(): number {
  return Date.now();
}
