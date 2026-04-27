"use client";

import { useActionState, useState } from "react";

import {
  syncNowGoogle,
  type SyncNowGoogleState,
} from "../settings/google-actions";
import { respondToReview, type RespondToReviewState } from "./actions";

const initial: RespondToReviewState = { status: "idle" };
const initialSync: SyncNowGoogleState = { status: "idle" };

export function SyncNowButton({ venueId }: { venueId: string }) {
  const [state, formAction, pending] = useActionState(syncNowGoogle, initialSync);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="venue_id" value={venueId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-hairline px-3 py-1.5 text-xs text-ink hover:border-ink disabled:opacity-50"
      >
        {pending ? "Syncing…" : "Sync now"}
      </button>
      {state.status === "saved" ? (
        <span className="text-xs text-ash" role="status">
          {state.upserted} review{state.upserted === 1 ? "" : "s"} synced ({state.fetched} seen)
        </span>
      ) : null}
      {state.status === "error" ? (
        <span className="text-xs text-red-600" role="alert">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

type Review = {
  id: string;
  rating: number;
  source: "internal" | "google" | "tripadvisor" | "facebook";
  submittedAt: Date;
  respondedAt: Date | null;
  guestFirstName: string;
  externalUrl: string | null;
  comment: string | null;
  response: string | null;
};

export function ReviewRow({ venueId, review }: { venueId: string; review: Review }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(respondToReview, initial);
  const responded = review.respondedAt !== null || state.status === "saved";
  // Internal replies email the guest; Google replies post via the
  // Business Profile API. Both flow through the same action with the
  // server picking the channel by source.
  const canReply = review.source === "internal" || review.source === "google";

  return (
    <li className="flex flex-col gap-3 rounded-card border border-hairline bg-white p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="font-medium text-ink">
            <Stars n={review.rating} /> {review.guestFirstName}
          </p>
          <p className="text-xs text-ash">
            {review.submittedAt.toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}{" "}
            ·{" "}
            {review.externalUrl ? (
              <a
                href={review.externalUrl}
                target="_blank"
                rel="noopener"
                className="underline hover:text-ink"
              >
                {review.source}
              </a>
            ) : (
              review.source
            )}
          </p>
        </div>
        {responded ? (
          <span className="rounded-full bg-cloud px-2 py-0.5 text-xs text-ash">Replied</span>
        ) : null}
      </header>

      {review.comment ? (
        <p className="whitespace-pre-line text-sm text-charcoal">{review.comment}</p>
      ) : (
        <p className="text-sm italic text-ash">No comment.</p>
      )}

      {review.response ? (
        <div className="rounded-md border-l-2 border-ink bg-cloud px-3 py-2">
          <p className="text-xs font-medium uppercase tracking-wider text-ash">Your reply</p>
          <p className="mt-1 whitespace-pre-line text-sm text-charcoal">{review.response}</p>
        </div>
      ) : null}

      {!responded && canReply ? (
        open ? (
          <form action={formAction} className="flex flex-col gap-2">
            <input type="hidden" name="review_id" value={review.id} />
            <input type="hidden" name="venue_id" value={venueId} />
            <textarea
              name="reply"
              rows={3}
              maxLength={800}
              placeholder={
                review.source === "google"
                  ? "Your reply will post publicly under this review on Google."
                  : "Reply directly to the guest by email — they'll see this in their inbox."
              }
              className="rounded-md border border-hairline px-3 py-2 text-sm outline-none focus:border-neutral-900"
              required
            />
            {state.status === "error" ? (
              <p role="alert" className="text-xs text-red-600">
                {state.message}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border border-hairline px-3 py-1.5 text-sm text-ink hover:border-ink"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending}
                className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-white hover:bg-charcoal disabled:opacity-50"
              >
                {pending ? "Sending…" : "Send reply"}
              </button>
            </div>
          </form>
        ) : (
          <div>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="rounded-md border border-hairline px-3 py-1.5 text-sm text-ink hover:border-ink"
            >
              Reply privately
            </button>
          </div>
        )
      ) : null}
    </li>
  );
}

function Stars({ n }: { n: number }) {
  return (
    <span aria-label={`${n} star${n === 1 ? "" : "s"}`} className="text-coral">
      {"★".repeat(n)}
      <span className="text-stone">{"★".repeat(5 - n)}</span>
    </span>
  );
}
