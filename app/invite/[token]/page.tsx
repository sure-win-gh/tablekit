import { eq } from "drizzle-orm";
import Link from "next/link";

import { resolveInvitation } from "@/lib/auth/invitations";
import { withUser } from "@/lib/db/client";
import { memberships } from "@/lib/db/schema";
import { supabaseServer } from "@/lib/db/supabase-server";

import { AcceptForm } from "./accept-form";

export const metadata = { title: "Accept invitation — TableKit" };

// Public accept-invite page. Two paths:
//   • Anonymous visitor: render the signup form pre-filled with the
//     invited email. Email field is read-only — the accept handler
//     refuses if the signup email doesn't match the invite, so we
//     reflect that constraint in the UI.
//   • Authenticated visitor: if their email matches the invite, show
//     a single "Accept" button. If it doesn't match, show an error
//     telling them which account the invite is for.
//
// Either way, expired/revoked/claimed tokens render a generic "this
// invite is no longer valid" page with a link back to the marketing
// site. We don't distinguish reasons — small but real anti-enum
// signal for attackers fishing token URLs.

export default async function AcceptInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invite = await resolveInvitation(token);

  if (!invite) {
    return (
      <main className="bg-cloud flex min-h-screen items-center justify-center p-6">
        <div className="border-hairline w-full max-w-md rounded-2xl border bg-white p-8 text-center shadow-sm">
          <h1 className="text-ink text-xl font-bold tracking-tight">Invitation unavailable</h1>
          <p className="text-ash mt-2 text-sm">
            This invite link is no longer valid — it may have expired, been revoked, or already
            been used.
          </p>
          <Link
            href="/"
            className="text-ink mt-4 inline-block text-sm font-medium underline-offset-2 hover:underline"
          >
            Back to TableKit
          </Link>
        </div>
      </main>
    );
  }

  // Is the visitor signed in already?
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const emailMatches =
      (user.email ?? "").toLowerCase() === invite.email.toLowerCase();

    // Already a member of this org? (e.g. the inviter clicked their
    // own link by mistake.) Skip the accept flow and bounce.
    if (emailMatches) {
      const alreadyMember = await withUser(async (db) => {
        const [row] = await db
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(eq(memberships.userId, user.id))
          .limit(1);
        return Boolean(row);
      });

      return (
        <main className="bg-cloud flex min-h-screen items-center justify-center p-6">
          <div className="border-hairline w-full max-w-md rounded-2xl border bg-white p-8 shadow-sm">
            <h1 className="text-ink text-xl font-bold tracking-tight">
              Join {invite.organisationName}
            </h1>
            <p className="text-ash mt-2 text-sm">
              You&apos;ve been invited as a <strong>{invite.role}</strong>. Click accept to join.
            </p>
            <AcceptForm
              token={token}
              mode="existing-user"
              orgName={invite.organisationName}
              email={invite.email}
            />
            {alreadyMember ? (
              <p className="text-ash mt-3 text-xs">
                You&apos;re already a member of another organisation. Accepting will add this one — you can switch between them in the dashboard sidebar.
              </p>
            ) : null}
          </div>
        </main>
      );
    }

    return (
      <main className="bg-cloud flex min-h-screen items-center justify-center p-6">
        <div className="border-hairline w-full max-w-md rounded-2xl border bg-white p-8 shadow-sm">
          <h1 className="text-ink text-xl font-bold tracking-tight">Wrong account</h1>
          <p className="text-ash mt-2 text-sm">
            This invite is for <strong>{invite.email}</strong>. You&apos;re signed in as{" "}
            <strong>{user.email}</strong>. Sign out and re-open the link from your invited email
            address.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="bg-cloud flex min-h-screen items-center justify-center p-6">
      <div className="border-hairline w-full max-w-md rounded-2xl border bg-white p-8 shadow-sm">
        <h1 className="text-ink text-xl font-bold tracking-tight">
          Join {invite.organisationName}
        </h1>
        <p className="text-ash mt-2 mb-6 text-sm">
          You&apos;ve been invited as a <strong>{invite.role}</strong>. Set up your password to
          continue.
        </p>
        <AcceptForm
          token={token}
          mode="new-user"
          orgName={invite.organisationName}
          email={invite.email}
        />
      </div>
    </main>
  );
}
