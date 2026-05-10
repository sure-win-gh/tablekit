import { redirect } from "next/navigation";

import { getMfaState } from "@/lib/auth/mfa";
import { supabaseServer } from "@/lib/db/supabase-server";

import { DisablePanel } from "./disable-panel";

// Per-user security settings. Owners and managers reach the dashboard
// only after passing the MfaWall, so this page exists primarily to
// let them DISABLE TOTP if they're switching devices — re-enrolment
// happens automatically on the next sign-in (wall fires again).
//
// Hosts (MFA optional) can also disable from here if they previously
// opted in. Voluntary enrolment for hosts is not yet wired through
// this page; the wall handles enrolment for required roles.

export const metadata = { title: "Security — TableKit" };

export default async function SecurityPage() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const mfa = await getMfaState();
  if (!mfa) redirect("/login");

  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <h1 className="text-ink text-2xl font-bold tracking-tight">Security</h1>
      <p className="text-ash mt-1 text-sm">Two-factor authentication for your account.</p>

      <section className="border-hairline mt-6 rounded-2xl border bg-white p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-ink text-base font-semibold">Authenticator app (TOTP)</h2>
            <p className="text-ash mt-1 text-xs">
              {mfa.hasVerifiedFactor
                ? mfa.currentLevel === "aal2"
                  ? "Enabled and verified for this session."
                  : "Enabled — you'll be prompted for a code on next sign-in."
                : "Not set up. Owners and managers are prompted to enrol when they sign in."}
            </p>
          </div>
          <span
            className={
              mfa.hasVerifiedFactor
                ? "rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-emerald-700 uppercase"
                : "bg-cloud text-ash rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase"
            }
          >
            {mfa.hasVerifiedFactor ? "ON" : "OFF"}
          </span>
        </div>

        {mfa.hasVerifiedFactor && mfa.factorId ? (
          <DisablePanel factorId={mfa.factorId} canDisable={mfa.currentLevel === "aal2"} />
        ) : null}
      </section>
    </div>
  );
}
