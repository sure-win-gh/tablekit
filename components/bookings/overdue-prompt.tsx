"use client";

// Overdue-table prompt — mounted in the venue layout so it appears on
// ANY dashboard screen for the venue. Polls the server every minute
// (which also runs the venue-scoped auto-finish sweep server-side);
// when seated bookings have lapsed their booked end time, shows a
// modal at most once per configured interval asking, per table:
// still seated (extend by one interval) or mark finished.
// See docs/specs/service-flow.md.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/components/ui";

import {
  extendOverdue,
  finishOverdue,
  pollOverdueSeated,
  type OverdueSeatedRow,
} from "@/app/(dashboard)/dashboard/venues/[venueId]/overdue-actions";

const POLL_MS = 60_000;

function snoozeKey(venueId: string): string {
  return `tk-overdue-snooze-${venueId}`;
}

function lastShownAt(venueId: string): number {
  try {
    return Number(sessionStorage.getItem(snoozeKey(venueId)) ?? 0);
  } catch {
    return 0;
  }
}

function markShown(venueId: string) {
  try {
    sessionStorage.setItem(snoozeKey(venueId), String(Date.now()));
  } catch {
    // sessionStorage unavailable (private mode edge cases) — the modal
    // simply re-prompts on the next poll; annoying, not broken.
  }
}

export function OverduePrompt({
  venueId,
  promptMinutes,
}: {
  venueId: string;
  // null = prompts disabled in venue settings; render nothing.
  promptMinutes: number | null;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<OverdueSeatedRow[]>([]);
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bookings already answered/acted on this showing — hidden from the
  // list so the modal shrinks as the operator works through it.
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());

  // The poll ALWAYS runs (when the tab is visible) — it drives the
  // server-side inline auto-finish sweep, which must keep working even
  // when prompts are set to Never. Only the modal is gated on
  // promptMinutes.
  const poll = useCallback(async () => {
    if (document.hidden) return;
    const r = await pollOverdueSeated({ venueId }).catch(() => null);
    if (!r || !r.ok) return;
    setRows(r.overdue);
    if (promptMinutes === null) return;
    const due = Date.now() - lastShownAt(venueId) >= promptMinutes * 60_000;
    if (r.overdue.length > 0 && due) {
      setHandled(new Set());
      setError(null);
      setOpen(true);
      markShown(venueId);
    }
    if (r.overdue.length === 0) setOpen(false);
  }, [venueId, promptMinutes]);

  useEffect(() => {
    // First poll via a short timer (not synchronously in the effect
    // body) so setState happens in an external-event callback.
    const first = setTimeout(() => void poll(), 1_000);
    const t = setInterval(() => void poll(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [poll]);

  // Snooze from DISMISS time (not show time) so reading the modal for
  // a while doesn't eat into the quiet interval.
  const dismiss = useCallback(() => {
    markShown(venueId);
    setOpen(false);
  }, [venueId]);

  // Basic dialog a11y: focus the panel on open, Escape dismisses.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dismiss]);

  if (promptMinutes === null || !open) return null;
  const visible = rows.filter((r) => !handled.has(r.bookingId));
  if (visible.length === 0) return null;

  const act = async (bookingId: string, kind: "finish" | "extend") => {
    setPendingId(bookingId);
    setError(null);
    const r =
      kind === "finish"
        ? await finishOverdue({ venueId, bookingId }).catch(() => null)
        : await extendOverdue({ venueId, bookingId, minutes: promptMinutes }).catch(() => null);
    setPendingId(null);
    if (!r || !r.ok) {
      setError(
        r && "reason" in r && r.reason === "slot-taken"
          ? "Can't extend — the next booking needs that table. Resolve it on the timeline."
          : "That didn't save — try again.",
      );
      return;
    }
    const nextHandled = new Set(handled).add(bookingId);
    setHandled(nextHandled);
    // Refresh whichever floor/timeline view sits underneath.
    router.refresh();
    if (rows.every((row) => nextHandled.has(row.bookingId))) setOpen(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Tables past their booked end time"
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
    >
      <button
        type="button"
        aria-label="Dismiss until next interval"
        onClick={dismiss}
        className="bg-ink/30 absolute inset-0 cursor-default"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="rounded-card border-hairline shadow-panel relative w-full max-w-md border bg-white p-5 outline-none"
      >
        <h2 className="text-ink text-base font-bold tracking-tight">Still seated?</h2>
        <p className="text-ash mt-0.5 text-xs">
          {visible.length === 1 ? "This table has" : "These tables have"} passed their booked end
          time.
        </p>

        <ul className="divide-hairline mt-3 flex flex-col divide-y">
          {visible.map((r) => (
            <li key={r.bookingId} className="flex flex-wrap items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-ink truncate text-sm font-semibold">
                  {r.guestFirstName} ×{r.partySize}
                  {r.tableLabels.length > 0 ? (
                    <span className="text-ash font-normal"> · T{r.tableLabels.join(", T")}</span>
                  ) : null}
                </p>
                <p className="text-ash text-xs tabular-nums">
                  booked until {r.endWall} · {r.overdueMinutes}m over
                </p>
              </div>
              <button
                type="button"
                disabled={pendingId !== null}
                onClick={() => void act(r.bookingId, "extend")}
                className={cn(
                  "rounded-pill border-hairline text-ink hover:border-ink border bg-white px-3 py-1 text-xs font-semibold transition disabled:opacity-50",
                )}
              >
                {pendingId === r.bookingId ? "…" : `Still seated +${promptMinutes}m`}
              </button>
              <button
                type="button"
                disabled={pendingId !== null}
                onClick={() => void act(r.bookingId, "finish")}
                className="rounded-pill bg-ink hover:bg-charcoal px-3 py-1 text-xs font-semibold text-white transition disabled:opacity-50"
              >
                {pendingId === r.bookingId ? "…" : "Mark finished"}
              </button>
            </li>
          ))}
        </ul>

        {error ? (
          <p role="alert" className="text-rose mt-3 text-xs">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={dismiss}
            className="text-ash hover:text-ink text-xs font-semibold transition"
          >
            Ask again in {promptMinutes} min
          </button>
        </div>
      </div>
    </div>
  );
}
