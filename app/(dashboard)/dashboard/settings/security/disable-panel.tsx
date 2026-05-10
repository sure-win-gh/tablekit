"use client";

import { useState, useTransition } from "react";

import { disableMfa } from "../../../mfa-actions";

// Client controls for disabling TOTP. Server-side enforcement of
// AAL2 lives in disableMfa(); the `canDisable` prop is just UX —
// disabling the button + showing the explanatory text — to avoid
// a confusing round-trip when the user clearly can't disable yet.
export function DisablePanel({ factorId, canDisable }: { factorId: string; canDisable: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    if (!canDisable) return;
    if (!window.confirm("Disable two-factor authentication on your account?")) return;
    setError(null);
    startTransition(async () => {
      const result = await disableMfa({ factorId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      window.location.reload();
    });
  };

  return (
    <div className="mt-4 border-t border-gray-100 pt-4">
      <button
        type="button"
        onClick={onClick}
        disabled={!canDisable || pending}
        className="text-coral border-coral hover:bg-coral disabled:hover:text-coral inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-medium transition hover:text-white disabled:opacity-50 disabled:hover:bg-transparent"
      >
        {pending ? "Disabling…" : "Disable TOTP"}
      </button>
      {!canDisable ? (
        <p className="text-ash mt-2 text-xs">
          Sign out and back in (completing the TOTP challenge) before disabling.
        </p>
      ) : null}
      {error ? <p className="text-coral mt-2 text-xs">{error}</p> : null}
    </div>
  );
}
