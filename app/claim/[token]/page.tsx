import Link from "next/link";

import { resolveClaim } from "@/lib/outreach/claim-resolve";
import { supabaseServer } from "@/lib/db/supabase-server";

import { ClaimForm } from "./claim-form";

export const metadata = { title: "Claim your venue — TableKit" };

// Public claim landing. Three render paths:
//   • Token unresolvable (expired / claimed / forged): generic
//     "no longer valid" page. Anti-enum signal — attackers fishing
//     token URLs see one response regardless of state.
//   • Authenticated visitor: ask them to log out. The signup path
//     creates a new auth.users row for the prospect's email, which
//     will collide with any already-signed-in user. PR 5b can add
//     an existing-user claim path if real demand surfaces.
//   • Anonymous visitor: render the claim form with email read-only.

export default async function ClaimPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const claim = await resolveClaim(token);

  if (!claim) {
    return (
      <Shell title="Link no longer valid">
        <p className="text-ash text-sm">
          This claim link has expired, already been used, or doesn&apos;t exist. If you were expecting
          to claim a venue, reply to the email and we&apos;ll resend a fresh link.
        </p>
        <Link
          href="/"
          className="text-ink mt-4 inline-block text-sm font-medium underline-offset-2 hover:underline"
        >
          Back to TableKit
        </Link>
      </Shell>
    );
  }

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    return (
      <Shell title="Sign out to continue">
        <p className="text-ash text-sm">
          This claim link is for <strong>{claim.prospectEmail}</strong>. You&apos;re currently signed in
          as <strong>{user.email}</strong>. Sign out and reopen the link to continue.
        </p>
      </Shell>
    );
  }

  return (
    <Shell title={`Claim ${claim.organisationName}`}>
      <p className="text-ash text-sm">
        We&apos;ve pre-populated TableKit with {claim.organisationName}&apos;s opening hours and a
        starter floor plan ({claim.tableCount} tables, {claim.serviceCount}{" "}
        {claim.serviceCount === 1 ? "service" : "services"}
        {claim.serviceNames ? `: ${claim.serviceNames}` : ""}). Set a password to take ownership.
      </p>
      <ClaimForm token={token} email={claim.prospectEmail} orgName={claim.organisationName} />
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="bg-cloud flex min-h-screen items-center justify-center p-6">
      <div className="border-hairline w-full max-w-md rounded-2xl border bg-white p-8 shadow-sm">
        <h1 className="text-ink text-xl font-bold tracking-tight">{title}</h1>
        <div className="mt-3 flex flex-col gap-3">{children}</div>
      </div>
    </main>
  );
}
