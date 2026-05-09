"use client";

import { useState, useTransition } from "react";

import { cn } from "@/components/ui";

import {
  enrolTotp,
  signOutFromWall,
  verifyChallenge,
  verifyEnrolment,
  type EnrolResult,
} from "./mfa-actions";

// Fullscreen wall rendered by the dashboard layout when an owner or
// manager hasn't completed TOTP. Two modes:
//
//   - "enrol"     — user has no verified factor. Show a "Set up TOTP"
//                   button which calls enrolTotp() to mint a fresh
//                   secret + QR code, then a verify-the-code form.
//   - "challenge" — user has a verified factor but session is at aal1.
//                   Show only the verify-the-code form.
//
// On success in either mode we router-refresh; the layout re-runs,
// the gate now passes, and the wall is replaced by the normal
// dashboard chrome.

type Props =
  | { mode: "enrol" }
  | { mode: "challenge"; factorId: string };

export function MfaWall(props: Props) {
  return (
    <div className="bg-cloud flex min-h-screen items-center justify-center p-6">
      <div className="border-hairline w-full max-w-md rounded-2xl border bg-white p-8 shadow-sm">
        <div className="mb-6">
          <h1 className="text-ink text-xl font-bold tracking-tight">
            {props.mode === "enrol" ? "Set up two-factor authentication" : "Enter your code"}
          </h1>
          <p className="text-ash mt-2 text-sm leading-relaxed">
            {props.mode === "enrol"
              ? "Owner and manager accounts are required to use TOTP. You'll need an authenticator app like 1Password, Authy, or Google Authenticator."
              : "Open your authenticator app and enter the 6-digit code for TableKit."}
          </p>
        </div>

        {props.mode === "enrol" ? <EnrolPanel /> : <ChallengePanel factorId={props.factorId} />}

        <form action={signOutFromWall} className="mt-6 border-t border-gray-100 pt-4">
          <button
            type="submit"
            className="text-ash hover:text-ink text-xs underline-offset-2 hover:underline"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}

function EnrolPanel() {
  const [pending, startTransition] = useTransition();
  const [enrolment, setEnrolment] = useState<EnrolResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const begin = () => {
    setError(null);
    startTransition(async () => {
      const result = await enrolTotp();
      setEnrolment(result);
      if (!result.ok) setError(result.message);
    });
  };

  if (!enrolment || !enrolment.ok) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={begin}
          disabled={pending}
          className="bg-ink text-white hover:bg-ink/90 disabled:opacity-60 inline-flex w-full items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium transition"
        >
          {pending ? "Generating secret…" : "Set up TOTP"}
        </button>
        {error ? <p className="text-coral text-xs">{error}</p> : null}
      </div>
    );
  }

  return <VerifyForm mode="enrol" factorId={enrolment.factorId} qrCodeSvg={enrolment.qrCodeSvg} secret={enrolment.secret} />;
}

function ChallengePanel({ factorId }: { factorId: string }) {
  return <VerifyForm mode="challenge" factorId={factorId} />;
}

function VerifyForm({
  mode,
  factorId,
  qrCodeSvg,
  secret,
}: {
  mode: "enrol" | "challenge";
  factorId: string;
  qrCodeSvg?: string;
  secret?: string;
}) {
  const [code, setCode] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const fn = mode === "enrol" ? verifyEnrolment : verifyChallenge;
      const result = await fn({ factorId, code });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // Hard reload — the layout re-runs server-side and the gate
      // now passes. router.refresh() also works, but a full reload
      // is more forgiving if some intermediate cache lingered.
      window.location.assign(window.location.pathname);
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {mode === "enrol" && qrCodeSvg ? (
        <div className="space-y-3">
          <p className="text-charcoal text-xs">Scan this QR code with your authenticator app:</p>
          <div className="border-hairline mx-auto w-fit rounded-lg border bg-white p-3">
            {/* Supabase returns the QR code as an inline SVG data
                URL — next/image can't optimise that, and we don't
                want to either (it's a one-shot render during
                enrolment). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrCodeSvg} alt="TOTP QR code" width={180} height={180} />
          </div>
          {secret ? (
            <details className="text-charcoal text-xs">
              <summary className="cursor-pointer">Or enter the secret manually</summary>
              <code className="bg-cloud mt-2 block rounded p-2 font-mono text-[11px] break-all">
                {secret}
              </code>
            </details>
          ) : null}
        </div>
      ) : null}

      <div>
        <label htmlFor="totp-code" className="text-charcoal block text-xs font-semibold">
          6-digit code
        </label>
        <input
          id="totp-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
          maxLength={8}
          pattern="[0-9]{6,8}"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          className={cn(
            "border-hairline focus:border-ink mt-1 w-full rounded-lg border px-3 py-2 text-base tracking-widest tabular-nums outline-none",
          )}
        />
      </div>

      {error ? <p className="text-coral text-xs">{error}</p> : null}

      <button
        type="submit"
        disabled={pending || code.length < 6}
        className="bg-ink text-white hover:bg-ink/90 disabled:opacity-60 inline-flex w-full items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium transition"
      >
        {pending ? "Verifying…" : "Verify"}
      </button>
    </form>
  );
}
