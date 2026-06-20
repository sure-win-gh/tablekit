"use client";

import { useActionState } from "react";

import { Button, Field, Input } from "@/components/ui";

import { resetPassword, type ResetPasswordState } from "./actions";

const initial: ResetPasswordState = { status: "idle" };

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(resetPassword, initial);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <Field label="New password" htmlFor="reset-pw">
        <Input
          id="reset-pw"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </Field>
      <p className="text-ash text-xs">At least 12 characters.</p>

      {state.status === "error" ? (
        <p role="alert" className="text-rose text-sm">
          {state.message}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="mt-2">
        {pending ? "Saving…" : "Set new password"}
      </Button>
    </form>
  );
}
