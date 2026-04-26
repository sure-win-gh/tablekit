"use client";

import { useActionState } from "react";

import { Button, Field, Input } from "@/components/ui";

import { signUp, type SignupState } from "./actions";

const initial: SignupState = { status: "idle" };

export function SignupForm() {
  const [state, formAction, pending] = useActionState(signUp, initial);

  if (state.status === "needs_confirm") {
    return (
      <div className="rounded-card border border-hairline bg-cloud p-4 text-sm text-charcoal">
        <p className="font-semibold text-ink">Check your inbox.</p>
        <p className="mt-1">
          We sent a confirmation link to <span className="font-mono">{state.email}</span>. Click it
          and you&apos;ll be taken to your dashboard.
        </p>
      </div>
    );
  }

  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Your name" htmlFor="su-name" error={fieldErrors?.["fullName"]?.[0]}>
        <Input
          id="su-name"
          name="full_name"
          type="text"
          autoComplete="name"
          required
          invalid={Boolean(fieldErrors?.["fullName"]?.[0])}
        />
      </Field>
      <Field
        label="Restaurant / café name"
        htmlFor="su-org"
        error={fieldErrors?.["orgName"]?.[0]}
      >
        <Input
          id="su-org"
          name="org_name"
          type="text"
          autoComplete="organization"
          required
          invalid={Boolean(fieldErrors?.["orgName"]?.[0])}
        />
      </Field>
      <Field label="Work email" htmlFor="su-email" error={fieldErrors?.["email"]?.[0]}>
        <Input
          id="su-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          invalid={Boolean(fieldErrors?.["email"]?.[0])}
        />
      </Field>
      <Field
        label="Password"
        htmlFor="su-pw"
        hint="At least 12 characters."
        error={fieldErrors?.["password"]?.[0]}
      >
        <Input
          id="su-pw"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          invalid={Boolean(fieldErrors?.["password"]?.[0])}
        />
      </Field>

      {state.status === "error" && !fieldErrors ? (
        <p role="alert" className="text-sm text-rose">
          {state.message}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="mt-2">
        {pending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
