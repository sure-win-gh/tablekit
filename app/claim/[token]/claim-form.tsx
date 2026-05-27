"use client";

import { useActionState } from "react";

import { claimAccount, type ClaimState } from "./actions";

const INITIAL: ClaimState = { status: "idle" };

export function ClaimForm({
  token,
  email,
  orgName,
}: {
  token: string;
  email: string;
  orgName: string;
}) {
  const [state, formAction, pending] = useActionState(claimAccount, INITIAL);

  if (state.status === "needs_confirm") {
    return (
      <div className="rounded-lg bg-emerald-50 p-4">
        <p className="text-sm font-medium text-emerald-900">Check your email</p>
        <p className="mt-1 text-xs text-emerald-800">
          We sent a confirmation link to {state.email}. Open it to finish claiming {orgName}.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-4 space-y-4">
      <input type="hidden" name="token" value={token} />
      <div>
        <label htmlFor="claim-email" className="text-charcoal block text-xs font-semibold">
          Email
        </label>
        <input
          id="claim-email"
          type="email"
          value={email}
          readOnly
          className="bg-cloud border-hairline mt-1 w-full rounded-lg border px-3 py-2 text-sm text-gray-600 outline-none"
        />
      </div>
      <div>
        <label htmlFor="claim-name" className="text-charcoal block text-xs font-semibold">
          Your name
        </label>
        <input
          id="claim-name"
          name="full_name"
          type="text"
          required
          maxLength={120}
          autoComplete="name"
          className="border-hairline focus:border-ink mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none"
        />
      </div>
      <div>
        <label htmlFor="claim-password" className="text-charcoal block text-xs font-semibold">
          Choose a password
        </label>
        <input
          id="claim-password"
          name="password"
          type="password"
          required
          minLength={12}
          maxLength={128}
          autoComplete="new-password"
          className="border-hairline focus:border-ink mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none"
        />
        <p className="text-ash mt-1 text-[11px]">At least 12 characters.</p>
      </div>
      {state.status === "error" ? <p className="text-coral text-xs">{state.message}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="bg-ink hover:bg-ink/90 inline-flex w-full items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-60"
      >
        {pending ? "Claiming…" : `Claim ${orgName}`}
      </button>
    </form>
  );
}
