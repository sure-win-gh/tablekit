"use client";

import { useActionState, useTransition } from "react";

import { acceptAsExistingUser, acceptAsNewUser, type AcceptState } from "./actions";

const INITIAL: AcceptState = { status: "idle" };

export function AcceptForm({
  token,
  mode,
  orgName,
  email,
}: {
  token: string;
  mode: "new-user" | "existing-user";
  orgName: string;
  email: string;
}) {
  if (mode === "existing-user") {
    return <ExistingUserAccept token={token} orgName={orgName} />;
  }
  return <NewUserAccept token={token} email={email} />;
}

function NewUserAccept({ token, email }: { token: string; email: string }) {
  const [state, formAction, pending] = useActionState(acceptAsNewUser, INITIAL);

  if (state.status === "needs_confirm") {
    return (
      <div className="rounded-lg bg-emerald-50 p-4">
        <p className="text-sm font-medium text-emerald-900">Check your email</p>
        <p className="mt-1 text-xs text-emerald-800">
          We sent a confirmation link to {state.email}. Open it to finish setting up your
          account.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <div>
        <label htmlFor="invite-email-display" className="text-charcoal block text-xs font-semibold">
          Email
        </label>
        <input
          id="invite-email-display"
          type="email"
          value={email}
          readOnly
          className="bg-cloud border-hairline mt-1 w-full rounded-lg border px-3 py-2 text-sm text-gray-600 outline-none"
        />
      </div>
      <div>
        <label htmlFor="invite-name" className="text-charcoal block text-xs font-semibold">
          Full name
        </label>
        <input
          id="invite-name"
          name="full_name"
          type="text"
          required
          maxLength={120}
          autoComplete="name"
          className="border-hairline focus:border-ink mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none"
        />
      </div>
      <div>
        <label htmlFor="invite-password" className="text-charcoal block text-xs font-semibold">
          Choose a password
        </label>
        <input
          id="invite-password"
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
        className="bg-ink hover:bg-ink/90 disabled:opacity-60 inline-flex w-full items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium text-white transition"
      >
        {pending ? "Creating account…" : "Accept invitation"}
      </button>
    </form>
  );
}

function ExistingUserAccept({ token, orgName }: { token: string; orgName: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="mt-6">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            await acceptAsExistingUser({ token });
          });
        }}
        className="bg-ink hover:bg-ink/90 disabled:opacity-60 inline-flex w-full items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium text-white transition"
      >
        {pending ? "Joining…" : `Join ${orgName}`}
      </button>
    </div>
  );
}
