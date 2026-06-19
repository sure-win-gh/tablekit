"use client";

import { useActionState, useState } from "react";

import { triggerPasswordReset, type TriggerResetState } from "./actions";

const initial: TriggerResetState = { status: "idle" };

// Support trigger for a member's password reset. The destination email is
// shown read-only and resolved server-side — this form only submits the
// user id + a reason. Support never sees or sets the password.
export function ResetPasswordControl({ userId, email }: { userId: string; email: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(triggerPasswordReset, initial);

  if (state.status === "success") {
    return <span className="text-ash">Reset link sent to {state.email}</span>;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-ink hover:text-coral underline underline-offset-2"
      >
        Send reset
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="userId" value={userId} />
      <p className="text-ash">
        Emails a reset link to <span className="font-mono">{email}</span>.
      </p>
      <input
        name="reason"
        placeholder="Reason / ticket ref"
        required
        minLength={3}
        maxLength={500}
        className="rounded-input border-hairline border px-2 py-1 text-xs"
      />
      {state.status === "error" ? (
        <span role="alert" className="text-rose">
          {state.message}
        </span>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="text-ink hover:text-coral underline underline-offset-2 disabled:opacity-50"
        >
          {pending ? "Sending…" : "Confirm send"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-ash hover:text-ink">
          Cancel
        </button>
      </div>
    </form>
  );
}
