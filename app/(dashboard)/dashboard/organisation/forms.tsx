"use client";

import { useActionState, useOptimistic, useTransition } from "react";

import { cn } from "@/components/ui";

import { toggleGroupCrm, type ToggleGroupCrmState } from "./actions";

const initial: ToggleGroupCrmState = { status: "idle" };

// Toggle for organisations.group_crm_enabled.
//
// Two React 19 idioms in play:
//   1. The action is dispatched inside a transition (Next 16 + React
//      19 require useActionState calls to live inside one).
//   2. Optimistic UI via useOptimistic — the switch flips instantly
//      on click; React reverts the optimistic value automatically
//      when the transition settles, then the action's confirmed
//      state takes over.
//
// On error, the optimistic flip auto-reverts when the transition
// resolves (since useOptimistic snaps back to the base state) and
// the error message renders below.

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
  const [, startTransition] = useTransition();

  // Source of truth: latest server-confirmed value if we have one,
  // otherwise the initial prop the server rendered with.
  const baseEnabled = state.status === "saved" ? state.enabled : initialEnabled;
  const [enabled, setOptimistic] = useOptimistic(
    baseEnabled,
    (_current: boolean, next: boolean) => next,
  );

  function onClick() {
    if (disabled || pending) return;
    const next = !enabled;
    const fd = new FormData();
    if (next) fd.set("groupCrmEnabled", "on");
    startTransition(() => {
      setOptimistic(next);
      formAction(fd);
    });
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="rounded-card border-hairline flex items-center justify-between border bg-white px-4 py-3">
        <div className="flex flex-col">
          <span className="text-ink text-sm font-semibold">Cross-venue guest list</span>
          <span className="text-ash text-xs">
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
        <p className="text-ash text-[11px]">Only owners can change this setting.</p>
      ) : null}
      {pending ? <p className="text-ash text-xs">Saving…</p> : null}
      {state.status === "error" ? <p className="text-rose text-xs">{state.message}</p> : null}
      {state.status === "saved" && !pending ? (
        <p className="text-xs text-emerald-700">Saved.</p>
      ) : null}
    </div>
  );
}
