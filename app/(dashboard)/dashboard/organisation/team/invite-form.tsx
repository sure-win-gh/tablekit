"use client";

import { useActionState } from "react";

import { createInvite, type CreateState } from "./actions";

const INITIAL: CreateState = { status: "idle" };

// Owner-only invite form. Submits to the createInvite server action;
// on success the page revalidates so the new invite appears in the
// pending list below without a manual refresh.
export function InviteForm() {
  const [state, formAction, pending] = useActionState(createInvite, INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_140px_auto]">
        <div>
          <label htmlFor="invite-email" className="sr-only">
            Email
          </label>
          <input
            id="invite-email"
            name="email"
            type="email"
            required
            placeholder="teammate@example.com"
            className="border-hairline focus:border-ink w-full rounded-lg border px-3 py-2 text-sm outline-none"
          />
        </div>
        <div>
          <label htmlFor="invite-role" className="sr-only">
            Role
          </label>
          <select
            id="invite-role"
            name="role"
            defaultValue="manager"
            className="border-hairline focus:border-ink w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none"
          >
            <option value="manager">Manager</option>
            <option value="host">Host</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="bg-ink hover:bg-ink/90 inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium text-white transition disabled:opacity-60"
        >
          {pending ? "Sending…" : "Send invite"}
        </button>
      </div>
      {state.status === "error" ? <p className="text-coral text-xs">{state.message}</p> : null}
      {state.status === "ok" ? (
        <p className="text-xs text-emerald-700">Invite sent to {state.email}.</p>
      ) : null}
    </form>
  );
}
