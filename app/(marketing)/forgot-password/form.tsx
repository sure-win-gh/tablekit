"use client";

import { useActionState } from "react";

import { Button, Field, Input } from "@/components/ui";

import { requestPasswordReset, type ForgotPasswordState } from "./actions";

const initial: ForgotPasswordState = { status: "idle" };

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, initial);

  if (state.status === "email_sent") {
    return (
      <div className="rounded-card border-hairline bg-cloud text-charcoal border p-4 text-sm">
        <p className="text-ink font-semibold">Check your inbox.</p>
        <p className="mt-1">
          If an account exists for <span className="font-mono">{state.email}</span>, we&rsquo;ve
          sent a link to reset your password. It expires in 15 minutes.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Email" htmlFor="forgot-email">
        <Input id="forgot-email" name="email" type="email" autoComplete="email" required />
      </Field>

      {state.status === "error" ? (
        <p role="alert" className="text-rose text-sm">
          {state.message}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="mt-2">
        {pending ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
