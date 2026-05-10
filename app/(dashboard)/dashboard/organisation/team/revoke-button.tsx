"use client";

import { useTransition } from "react";

import { revokeInvite } from "./actions";

export function RevokeButton({ inviteId }: { inviteId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!window.confirm("Revoke this invitation?")) return;
        startTransition(async () => {
          await revokeInvite({ inviteId });
        });
      }}
      className="text-coral border-coral hover:bg-coral inline-flex shrink-0 items-center rounded-lg border px-2.5 py-1 text-xs font-medium transition hover:text-white disabled:opacity-50"
    >
      {pending ? "Revoking…" : "Revoke"}
    </button>
  );
}
