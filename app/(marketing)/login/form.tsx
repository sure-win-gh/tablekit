"use client";

import { useActionState, useState } from "react";

import { Button, Field, Input, cn } from "@/components/ui";

import { signInWithMagicLink, signInWithPassword, type LoginState } from "./actions";

const initial: LoginState = { status: "idle" };

type Mode = "password" | "magic";

export function LoginForm() {
  const [mode, setMode] = useState<Mode>("password");
  const action = mode === "password" ? signInWithPassword : signInWithMagicLink;
  const [state, formAction, pending] = useActionState(action, initial);

  if (state.status === "magic_sent") {
    return (
      <div className="rounded-card border border-hairline bg-cloud p-4 text-sm text-charcoal">
        <p className="font-semibold text-ink">Check your inbox.</p>
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
        className="flex gap-1 rounded-pill bg-cloud p-1 text-sm"
      >
        <ModeTab active={mode === "password"} onClick={() => setMode("password")}>
          Password
        </ModeTab>
        <ModeTab active={mode === "magic"} onClick={() => setMode("magic")}>
          Magic link
        </ModeTab>
      </div>

      <form action={formAction} className="flex flex-col gap-4">
        <Field label="Email" htmlFor="login-email">
          <Input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
        </Field>
        {mode === "password" ? (
          <Field label="Password" htmlFor="login-pw">
            <Input
              id="login-pw"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
        ) : null}

        {state.status === "error" ? (
          <p role="alert" className="text-sm text-rose">
            {state.message}
          </p>
        ) : null}

        <Button type="submit" disabled={pending} className="mt-2">
          {pending
            ? mode === "password"
              ? "Signing in…"
              : "Sending link…"
            : mode === "password"
              ? "Sign in"
              : "Send magic link"}
        </Button>
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
      className={cn(
        "flex-1 rounded-pill px-3 py-1.5 text-sm font-semibold transition",
        active ? "bg-white text-ink shadow-panel" : "text-ash hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
