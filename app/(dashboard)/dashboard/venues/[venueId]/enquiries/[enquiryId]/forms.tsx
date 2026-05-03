"use client";

// Client-side forms for the enquiry detail page. Each action calls
// the corresponding server action and surfaces a toast-equivalent
// inline error band on failure.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  type ActionResult,
  dismissEnquiryAction,
  resetOrphanAction,
  retryFailedAction,
  sendDraftAction,
} from "../actions";

type CommonProps = {
  venueId: string;
  enquiryId: string;
};

export function SendDraftForm({
  venueId,
  enquiryId,
  initialSubject,
  initialBody,
}: CommonProps & { initialSubject: string; initialBody: string }) {
  const router = useRouter();
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const r: ActionResult = await sendDraftAction({
            venueId,
            enquiryId,
            subject,
            body,
          });
          if (!r.ok) {
            setError(r.error);
            return;
          }
          router.refresh();
        });
      }}
      className="flex flex-col gap-3"
    >
      <label className="flex flex-col gap-1">
        <span className="text-ash text-xs font-medium tracking-wide uppercase">Subject</span>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={200}
          required
          className="rounded-card border-hairline focus:border-ink border bg-white px-3 py-2 text-sm outline-none"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-ash text-xs font-medium tracking-wide uppercase">Reply</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={12}
          maxLength={10_000}
          required
          className="rounded-card border-hairline focus:border-ink border bg-white px-3 py-2 text-sm outline-none"
        />
      </label>
      {error ? (
        <p className="rounded-card bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-card bg-ink hover:bg-ink/90 px-4 py-2 text-sm font-medium text-white transition disabled:bg-stone-400"
        >
          {pending ? "Sending…" : "Send reply"}
        </button>
        <DismissButton venueId={venueId} enquiryId={enquiryId} />
      </div>
    </form>
  );
}

export function DismissButton({ venueId, enquiryId }: CommonProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const r = await dismissEnquiryAction({ venueId, enquiryId });
            if (!r.ok) {
              setError(r.error);
              return;
            }
            router.push(`/dashboard/venues/${venueId}/enquiries`);
          });
        }}
        className="rounded-card border-hairline hover:border-ink border bg-white px-4 py-2 text-sm transition disabled:opacity-50"
      >
        {pending ? "Dismissing…" : "Dismiss"}
      </button>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </>
  );
}

export function ResetOrphanButton({ venueId, enquiryId }: CommonProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const r = await resetOrphanAction({ venueId, enquiryId });
            if (!r.ok) {
              setError(r.error);
              return;
            }
            router.refresh();
          });
        }}
        className="rounded-card border-hairline hover:border-ink border bg-white px-4 py-2 text-sm transition disabled:opacity-50"
      >
        {pending ? "Resetting…" : "Reset stuck enquiry"}
      </button>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}

export function RetryFailedButton({ venueId, enquiryId }: CommonProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const r = await retryFailedAction({ venueId, enquiryId });
            if (!r.ok) {
              setError(r.error);
              return;
            }
            router.refresh();
          });
        }}
        className="rounded-card border-hairline hover:border-ink border bg-white px-4 py-2 text-sm transition disabled:opacity-50"
      >
        {pending ? "Retrying…" : "Retry parse"}
      </button>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
