"use client";

import { useActionState, useState } from "react";

import { Button, Field, Textarea } from "@/components/ui";
import type { DsarStatus } from "@/lib/dsar/transition";

import { actOnDsar, type ActOnDsarState } from "./actions";

const initial: ActOnDsarState = { status: "idle" };

// Available transitions per current status — mirrors lib/dsar/transition's
// allowed map. Disabling the action bar entirely on terminal states
// keeps the operator from clicking into a dead-end.

const NEXT: Record<DsarStatus, DsarStatus[]> = {
  pending: ["in_progress", "rejected"],
  in_progress: ["completed", "rejected"],
  completed: [],
  rejected: [],
};

const LABEL: Record<DsarStatus, string> = {
  pending: "Pending",
  in_progress: "Mark in progress",
  completed: "Mark completed",
  rejected: "Reject",
};

export function RequestActions({
  dsarId,
  status,
  existingNotes,
}: {
  dsarId: string;
  status: DsarStatus;
  existingNotes: string;
}) {
  const [state, formAction, pending] = useActionState(actOnDsar, initial);
  const [notes, setNotes] = useState(existingNotes);
  const targets = NEXT[status];

  if (targets.length === 0) {
    return (
      <p className="text-ash text-xs">
        This request is closed. To re-open, the requester needs to submit a fresh request.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="dsarId" value={dsarId} />

      <Field
        label="Resolution notes"
        htmlFor="dsar-notes"
        hint="Visible to your team and the audit log. Don't paste exported PII here."
        optional
      >
        <Textarea
          id="dsar-notes"
          name="resolutionNotes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={2000}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        {targets.map((to) => (
          <Button
            key={to}
            type="submit"
            name="to"
            value={to}
            variant={to === "rejected" ? "destructive" : "primary"}
            disabled={pending}
          >
            {pending ? "…" : LABEL[to]}
          </Button>
        ))}
        {state.status === "error" ? (
          <span className="text-rose text-xs">{state.message}</span>
        ) : null}
        {state.status === "done" ? <span className="text-xs text-emerald-700">Saved.</span> : null}
      </div>
    </form>
  );
}
