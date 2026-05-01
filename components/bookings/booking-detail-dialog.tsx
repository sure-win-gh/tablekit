"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";

import { Button, Field, Input, Textarea, cn } from "@/components/ui";
import type { BookingDetailPayload, VenueTableForDetail } from "@/lib/bookings/detail";
import { nextActions, type BookingStatus } from "@/lib/bookings/state";
import { STATUS_FILL } from "@/lib/bookings/status-style";

import {
  refundBookingAction,
  transitionBookingAction,
} from "@/app/(dashboard)/dashboard/venues/[venueId]/bookings/actions";
import {
  reassignFromTimeline,
  shiftFromTimeline,
  updateDetailsFromTimeline,
} from "@/app/(dashboard)/dashboard/venues/[venueId]/timeline/actions";

const STATUS_LABEL: Record<BookingStatus, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
  seated: "Seated",
  finished: "Finished",
  cancelled: "Cancelled",
  no_show: "No-show",
};

const ACTION_LABEL: Record<BookingStatus, string> = {
  requested: "Request",
  confirmed: "Confirm",
  seated: "Seat",
  finished: "Finish",
  cancelled: "Cancel",
  no_show: "No-show",
};

function reassignErrorMessage(reason: string): string {
  switch (reason) {
    case "wrong-area":
      return "Different area";
    case "slot-taken":
      return "Slot taken";
    case "not-found":
      return "Not found";
    default:
      return "Failed";
  }
}

function shiftErrorMessage(reason: string): string {
  switch (reason) {
    case "slot-taken":
      return "Time taken";
    case "terminal-status":
      return "Already closed";
    case "not-found":
    case "venue-not-found":
      return "Not found";
    default:
      return "Failed";
  }
}

type Props = {
  venueId: string;
  date: string;
  booking: BookingDetailPayload;
  allVenueTables: VenueTableForDetail[];
  onClose: () => void;
};

// Modal dialog with a backdrop. Mounts on top of whatever opened it.
// Closes on backdrop click + ESC. The body is `key`-ed by booking id so
// transient form state (mode, drafts) resets cleanly when a new
// booking opens the dialog from the same parent.
export function BookingDetailDialog(props: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [props]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Booking detail"
      onClick={props.onClose}
      className="bg-ink/40 fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-card border-hairline shadow-panel w-full max-w-md border bg-white"
      >
        <BookingDetailDialogBody key={props.booking.id} {...props} />
      </div>
    </div>
  );
}

function BookingDetailDialogBody({ venueId, date, booking, allVenueTables, onClose }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<
    "view" | "edit-time" | "edit-details" | "refund" | "cancel-with-reason" | "reassign-table"
  >("view");
  const [error, setError] = useState<string | null>(null);
  const [newWallStart, setNewWallStart] = useState(booking.wallStart);
  const [refundReason, setRefundReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [draftPartySize, setDraftPartySize] = useState(booking.partySize);
  const [draftNotes, setDraftNotes] = useState(booking.notes ?? "");
  const [reassignTo, setReassignTo] = useState("");

  const editable =
    booking.status !== "cancelled" && booking.status !== "no_show" && booking.status !== "finished";
  const transitionsAvailable = nextActions(booking.status);

  const moveTargets = allVenueTables.filter(
    (t) =>
      t.areaId === booking.areaId && t.maxCover >= booking.partySize && t.id !== booking.tableId,
  );

  function onSaveTime() {
    if (!newWallStart || newWallStart === booking.wallStart) {
      setMode("view");
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await shiftFromTimeline({
        venueId,
        bookingId: booking.id,
        date,
        wallStart: newWallStart,
      });
      if (!r.ok) {
        setError(shiftErrorMessage(r.reason));
        return;
      }
      onClose();
      router.refresh();
    });
  }

  function onTransition(to: BookingStatus) {
    if (to === "cancelled") {
      setMode("cancel-with-reason");
      setCancelReason("");
      setError(null);
      return;
    }
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("venueId", venueId);
      fd.set("bookingId", booking.id);
      fd.set("to", to);
      const r = await transitionBookingAction({ status: "idle" }, fd);
      if (r.status === "error") {
        setError(r.message);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  function onConfirmCancel() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("venueId", venueId);
      fd.set("bookingId", booking.id);
      fd.set("to", "cancelled");
      if (cancelReason.trim()) fd.set("cancelledReason", cancelReason.trim());
      const r = await transitionBookingAction({ status: "idle" }, fd);
      if (r.status === "error") {
        setError(r.message);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  function onSaveDetails() {
    const notesChanged = draftNotes !== (booking.notes ?? "");
    const partyChanged = draftPartySize !== booking.partySize;
    if (!notesChanged && !partyChanged) {
      setMode("view");
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await updateDetailsFromTimeline({
        venueId,
        bookingId: booking.id,
        ...(notesChanged ? { notes: draftNotes.trim() === "" ? null : draftNotes } : {}),
        ...(partyChanged ? { partySize: draftPartySize } : {}),
      });
      if (!r.ok) {
        setError(r.message ?? "Couldn't save.");
        return;
      }
      onClose();
      router.refresh();
    });
  }

  function onConfirmReassign() {
    if (!reassignTo) return;
    setError(null);
    startTransition(async () => {
      const r = await reassignFromTimeline({
        venueId,
        bookingId: booking.id,
        fromTableId: booking.tableId,
        toTableId: reassignTo,
      });
      if (!r.ok) {
        setError(reassignErrorMessage(r.reason));
        return;
      }
      onClose();
      router.refresh();
    });
  }

  function onConfirmRefund() {
    if (refundReason.trim().length < 3) {
      setError("Reason must be at least 3 characters.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("venueId", venueId);
      fd.set("bookingId", booking.id);
      fd.set("reason", refundReason.trim());
      const r = await refundBookingAction({ status: "idle" }, fd);
      if (r.status === "error") {
        setError(r.message);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <>
      <header className="border-hairline flex items-start justify-between gap-2 border-b px-5 py-4">
        <div>
          <h3 className="text-ink text-base font-bold tracking-tight">
            <Link href={`/dashboard/guests/${booking.guestId}`} className="hover:underline">
              {booking.guestFirstName}
            </Link>
          </h3>
          <p className="text-ash mt-0.5 text-xs">
            {booking.wallStart}–{booking.wallEnd} · {booking.tableLabel} · {booking.serviceName}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-ash hover:bg-cloud hover:text-ink -mt-1 -mr-1 inline-flex h-7 w-7 items-center justify-center rounded-full transition"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>

      <div className="text-charcoal flex flex-col gap-3 px-5 py-4 text-sm">
        <DetailRow label="Status">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "rounded-pill inline-flex items-center border px-2 py-0.5 text-[11px] font-semibold",
                STATUS_FILL[booking.status],
              )}
            >
              {STATUS_LABEL[booking.status]}
            </span>
            {mode === "view" && transitionsAvailable.length > 0
              ? transitionsAvailable.map((to) => (
                  <Button
                    key={to}
                    type="button"
                    size="sm"
                    variant={to === "cancelled" ? "destructive" : "secondary"}
                    onClick={() => onTransition(to)}
                    disabled={pending}
                  >
                    {ACTION_LABEL[to]}
                  </Button>
                ))
              : null}
          </div>
        </DetailRow>
        <DetailRow label="Party size">
          <span className="font-mono tabular-nums">{booking.partySize}</span>
        </DetailRow>
        {booking.notes ? (
          <DetailRow label="Notes">
            <span className="whitespace-pre-line">{booking.notes}</span>
          </DetailRow>
        ) : null}

        {booking.cardHold && !booking.noShowOutcome ? (
          <DetailRow label="Card on file">
            <span className="text-ash text-xs">Hold succeeded — captured only on no-show.</span>
          </DetailRow>
        ) : null}
        {booking.noShowOutcome === "captured" ? (
          <DetailRow label="No-show">
            <span className="text-xs text-emerald-700">Capture succeeded.</span>
          </DetailRow>
        ) : null}
        {booking.noShowOutcome === "failed" ? (
          <DetailRow label="No-show">
            <span className="text-rose text-xs">Capture failed — see Stripe.</span>
          </DetailRow>
        ) : null}

        {mode === "edit-time" ? (
          <div className="rounded-card border-hairline bg-cloud mt-2 flex flex-col gap-2 border p-3">
            <Field
              label="New start time"
              htmlFor="bdm-time"
              hint={`Duration ${booking.durationMinutes} min — preserved.`}
            >
              <Input
                id="bdm-time"
                type="time"
                step={900}
                value={newWallStart}
                onChange={(e) => setNewWallStart(e.target.value)}
                size="sm"
                className="w-32"
              />
            </Field>
            {error ? <p className="text-rose text-xs">{error}</p> : null}
          </div>
        ) : null}

        {mode === "refund" ? (
          <div className="rounded-card border-rose/30 bg-rose/5 mt-2 flex flex-col gap-2 border p-3">
            <Field
              label="Refund reason"
              htmlFor="bdm-refund-reason"
              hint="Required — at least 3 characters. Recorded in the audit log."
            >
              <Input
                id="bdm-refund-reason"
                type="text"
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                minLength={3}
                maxLength={200}
                size="sm"
              />
            </Field>
            {error ? <p className="text-rose text-xs">{error}</p> : null}
          </div>
        ) : null}

        {mode === "cancel-with-reason" ? (
          <div className="rounded-card border-rose/30 bg-rose/5 mt-2 flex flex-col gap-2 border p-3">
            <Field
              label="Cancellation reason"
              htmlFor="bdm-cancel-reason"
              hint="Optional — recorded on the booking + audit log."
              optional
            >
              <Input
                id="bdm-cancel-reason"
                type="text"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                maxLength={200}
                size="sm"
              />
            </Field>
            {error ? <p className="text-rose text-xs">{error}</p> : null}
          </div>
        ) : null}

        {mode === "edit-details" ? (
          <div className="rounded-card border-hairline bg-cloud mt-2 flex flex-col gap-3 border p-3">
            <Field label="Party size" htmlFor="bdm-party">
              <Input
                id="bdm-party"
                type="number"
                min={1}
                max={20}
                value={draftPartySize}
                onChange={(e) =>
                  setDraftPartySize(Math.max(1, Math.min(20, Number(e.target.value) || 1)))
                }
                size="sm"
                className="w-24"
              />
            </Field>
            <Field label="Notes" htmlFor="bdm-notes" optional>
              <Textarea
                id="bdm-notes"
                value={draftNotes}
                onChange={(e) => setDraftNotes(e.target.value)}
                rows={3}
                maxLength={500}
              />
            </Field>
            {error ? <p className="text-rose text-xs">{error}</p> : null}
          </div>
        ) : null}

        {mode === "reassign-table" ? (
          <div className="rounded-card border-hairline bg-cloud mt-2 flex flex-col gap-2 border p-3">
            {moveTargets.length === 0 ? (
              <p className="text-ash text-xs">
                No same-area tables with capacity ≥ {booking.partySize}.
              </p>
            ) : (
              <Field
                label="Move to table"
                htmlFor="bdm-reassign"
                hint="Same area, capacity ≥ party. Cross-area moves stay drag-only."
              >
                <select
                  id="bdm-reassign"
                  value={reassignTo}
                  onChange={(e) => setReassignTo(e.target.value)}
                  className="rounded-input border-hairline text-ink focus:border-ink focus:ring-ink w-full border bg-white px-2 py-1 text-sm focus:ring-2 focus:outline-none"
                >
                  <option value="">Pick a table…</option>
                  {moveTargets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.areaName} · {t.label} (cap {t.maxCover})
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {error ? <p className="text-rose text-xs">{error}</p> : null}
          </div>
        ) : null}

        {mode === "view" && error ? <p className="text-rose text-xs">{error}</p> : null}
      </div>

      <footer className="border-hairline flex items-center justify-end gap-2 border-t px-5 py-3">
        {mode === "edit-time" ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setMode("view");
                setNewWallStart(booking.wallStart);
                setError(null);
              }}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={onSaveTime} disabled={pending}>
              {pending ? "Saving…" : "Save time"}
            </Button>
          </>
        ) : mode === "refund" ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setMode("view");
                setRefundReason("");
                setError(null);
              }}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={onConfirmRefund}
              disabled={pending || refundReason.trim().length < 3}
            >
              {pending ? "Refunding…" : "Confirm refund"}
            </Button>
          </>
        ) : mode === "cancel-with-reason" ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setMode("view");
                setCancelReason("");
                setError(null);
              }}
              disabled={pending}
            >
              Back
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={onConfirmCancel}
              disabled={pending}
            >
              {pending ? "Cancelling…" : "Confirm cancel"}
            </Button>
          </>
        ) : mode === "edit-details" ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setMode("view");
                setDraftPartySize(booking.partySize);
                setDraftNotes(booking.notes ?? "");
                setError(null);
              }}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={onSaveDetails} disabled={pending}>
              {pending ? "Saving…" : "Save details"}
            </Button>
          </>
        ) : mode === "reassign-table" ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setMode("view");
                setReassignTo("");
                setError(null);
              }}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={onConfirmReassign}
              disabled={pending || !reassignTo}
            >
              {pending ? "Moving…" : "Move table"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
            {editable ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setMode("edit-details");
                  setDraftPartySize(booking.partySize);
                  setDraftNotes(booking.notes ?? "");
                  setError(null);
                }}
              >
                Edit details
              </Button>
            ) : null}
            {editable && moveTargets.length > 0 ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setMode("reassign-table");
                  setReassignTo("");
                  setError(null);
                }}
              >
                Move table
              </Button>
            ) : null}
            {editable ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setMode("edit-time");
                  setError(null);
                }}
              >
                Edit time
              </Button>
            ) : null}
            {booking.refundable ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setMode("refund");
                  setRefundReason("");
                  setError(null);
                }}
              >
                Refund
              </Button>
            ) : null}
          </>
        )}
      </footer>
    </>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ash text-[11px] font-semibold tracking-wider uppercase">{label}</span>
      <span className="text-ink text-sm">{children}</span>
    </div>
  );
}
