"use client";

// Replay button for an individual delivery row.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { replayDeliveryAction } from "./actions";

export function ReplayButton({
  deliveryId,
  subscriptionId,
}: {
  deliveryId: string;
  subscriptionId: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const r = await replayDeliveryAction({ deliveryId, subscriptionId });
            if (!r.ok) {
              setError(r.error);
              return;
            }
            router.refresh();
          });
        }}
        className="rounded-card border-hairline hover:border-ink border bg-white px-3 py-1 text-xs transition disabled:opacity-50"
      >
        {pending ? "Replaying…" : "Replay"}
      </button>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
