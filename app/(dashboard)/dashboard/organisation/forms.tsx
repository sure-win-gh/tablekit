"use client";

import { useActionState, useState } from "react";

import { Button, cn } from "@/components/ui";

import { toggleGroupCrm, type ToggleGroupCrmState } from "./actions";

const initial: ToggleGroupCrmState = { status: "idle" };

// Toggle for organisations.group_crm_enabled. Optimistic UI on the
// switch state so the click reads as instant; the server action
// confirms (or reverts) when it returns. Submit happens on click;
// no separate "Save" button — the switch is the action.

export function GroupCrmToggle({
  initialEnabled,
  disabled,
  ownerOnlyHint,
}: {
  initialEnabled: boolean;
  disabled?: boolean;
  ownerOnlyHint?: boolean;
}) {
  const [state, formAction, pending] = useActionState(toggleGroupCrm, initial);
  const [enabled, setEnabled] = useState(initialEnabled);

  function onClick() {
    if (disabled || pending) return;
    setEnabled((v) => !v);
    const fd = new FormData();
    if (!enabled) fd.set("groupCrmEnabled", "on");
    formAction(fd);
  }

  // Sync from server state if it differs (e.g. user double-clicks
  // and the server resolves the older value last).
  if (state.status === "saved" && state.enabled !== enabled) {
    setEnabled(state.enabled);
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex items-center justify-between rounded-card border border-hairline bg-white px-4 py-3">
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-ink">Cross-venue guest list</span>
          <span className="text-xs text-ash">
            Off — guests are scoped per venue. On — operators see all guests across the org.
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-disabled={disabled}
          onClick={onClick}
          className={cn(
            "relative inline-flex h-6 w-11 items-center rounded-full transition",
            enabled ? "bg-coral" : "bg-stone",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          <span
            className={cn(
              "inline-block h-5 w-5 transform rounded-full bg-white shadow transition",
              enabled ? "translate-x-5" : "translate-x-0.5",
            )}
          />
        </button>
      </div>
      {ownerOnlyHint ? (
        <p className="text-[11px] text-ash">Only owners can change this setting.</p>
      ) : null}
      {state.status === "error" ? (
        <p className="text-xs text-rose">{state.message}</p>
      ) : null}
      {state.status === "saved" ? (
        <p className="text-xs text-emerald-700">Saved.</p>
      ) : null}
      <Button type="button" variant="link" className="self-start text-xs" disabled>
        {pending ? "Saving…" : null}
      </Button>
    </div>
  );
}
