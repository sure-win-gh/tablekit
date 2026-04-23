"use client";

import { useActionState, useState } from "react";

import { signInWithMagicLink, signInWithPassword, type LoginState } from "./actions";

const initial: LoginState = { status: "idle" };

type Mode = "password" | "magic";

export function LoginForm() {
  const [mode, setMode] = useState<Mode>("password");
  const action = mode === "password" ? signInWithPassword : signInWithMagicLink;
  const [state, formAction, pending] = useActionState(action, initial);

  if (state.status === "magic_sent") {
    return (
      <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700">
        <p className="font-medium text-neutral-900">Check your inbox.</p>
        <p className="mt-1">
          We sent a sign-in link to <span className="font-mono">{state.email}</span>. Open it on
          this device.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label="Sign-in method"
        className="flex gap-1 rounded-md bg-neutral-100 p-1 text-sm"
      >
        <ModeTab active={mode === "password"} onClick={() => setMode("password")}>
          Password
        </ModeTab>
        <ModeTab active={mode === "magic"} onClick={() => setMode("magic")}>
          Magic link
        </ModeTab>
      </div>

      <form action={formAction} className="flex flex-col gap-4">
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        {mode === "password" ? (
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        ) : null}

        {state.status === "error" ? (
          <p role="alert" className="text-sm text-red-600">
            {state.message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="mt-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50"
        >
          {pending
            ? mode === "password"
              ? "Signing in…"
              : "Sending link…"
            : mode === "password"
              ? "Sign in"
              : "Send magic link"}
        </button>
      </form>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 rounded px-3 py-1.5 transition ${
        active ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-600 hover:text-neutral-900"
      }`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  name,
  type,
  autoComplete,
  required,
}: {
  label: string;
  name: string;
  type: "email" | "password";
  autoComplete?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-neutral-900">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
      />
    </label>
  );
}
