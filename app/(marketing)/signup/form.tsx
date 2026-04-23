"use client";

import { useActionState } from "react";

import { signUp, type SignupState } from "./actions";

const initial: SignupState = { status: "idle" };

export function SignupForm() {
  const [state, formAction, pending] = useActionState(signUp, initial);

  if (state.status === "needs_confirm") {
    return (
      <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700">
        <p className="font-medium text-neutral-900">Check your inbox.</p>
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
      <Field
        label="Your name"
        name="full_name"
        type="text"
        autoComplete="name"
        required
        error={fieldErrors?.["fullName"]?.[0]}
      />
      <Field
        label="Restaurant / café name"
        name="org_name"
        type="text"
        autoComplete="organization"
        required
        error={fieldErrors?.["orgName"]?.[0]}
      />
      <Field
        label="Work email"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={fieldErrors?.["email"]?.[0]}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={12}
        hint="At least 12 characters."
        error={fieldErrors?.["password"]?.[0]}
      />

      {state.status === "error" && !fieldErrors ? (
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="mt-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50"
      >
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}

type FieldProps = {
  label: string;
  name: string;
  type: "text" | "email" | "password";
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  hint?: string;
  error?: string | undefined;
};

function Field({ label, name, type, autoComplete, required, minLength, hint, error }: FieldProps) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-neutral-900">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        aria-invalid={Boolean(error)}
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
      />
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      ) : hint ? (
        <span className="text-xs text-neutral-500">{hint}</span>
      ) : null}
    </label>
  );
}
