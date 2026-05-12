"use client";

import { useActionState, useRef, useState, useTransition } from "react";

import { syncNowGoogle, type SyncNowGoogleState } from "../settings/google-actions";
import {
  respondToReview,
  sendRecoveryOffer,
  suggestReplyDraft,
  type RespondToReviewState,
  type SendRecoveryOfferState,
} from "./actions";

const initial: RespondToReviewState = { status: "idle" };
const initialSync: SyncNowGoogleState = { status: "idle" };
const initialRecovery: SendRecoveryOfferState = { status: "idle" };

export function SyncNowButton({ venueId }: { venueId: string }) {
  const [state, formAction, pending] = useActionState(syncNowGoogle, initialSync);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="venue_id" value={venueId} />
      <button
        type="submit"
        disabled={pending}
        className="border-hairline text-ink hover:border-ink rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
      >
        {pending ? "Syncing…" : "Sync now"}
      </button>
      {state.status === "saved" ? (
        <span className="text-ash text-xs" role="status">
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
  recoveryOfferAt: Date | null;
  guestFirstName: string;
  externalUrl: string | null;
  comment: string | null;
  response: string | null;
  // Phase 5 — null until the AI classifier runs (fire-and-forget on
  // submit). Rendered as a small badge alongside the star rating.
  sentiment: "positive" | "neutral" | "negative" | null;
};

export function ReviewRow({ venueId, review }: { venueId: string; review: Review }) {
  const [open, setOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [state, formAction, pending] = useActionState(respondToReview, initial);
  const [recoveryState, recoveryAction, recoveryPending] = useActionState(
    sendRecoveryOffer,
    initialRecovery,
  );
  const responded = review.respondedAt !== null || state.status === "saved";
  const recoverySent = review.recoveryOfferAt !== null || recoveryState.status === "saved";
  // Internal replies email the guest; Google replies post via the
  // Business Profile API. Both flow through the same action with the
  // server picking the channel by source.
  const canReply = review.source === "internal" || review.source === "google";
  // Recovery offers are internal-only — Google reviewers don't have a
  // guest row in our DB. Show the button for low-rated internal rows.
  const canRecover = review.source === "internal" && review.rating <= 3;

  return (
    <li className="rounded-card border-hairline flex flex-col gap-3 border bg-white p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-ink flex items-center gap-2 font-medium">
            <Stars n={review.rating} /> {review.guestFirstName}
            {review.sentiment ? <SentimentBadge sentiment={review.sentiment} /> : null}
          </p>
          <p className="text-ash text-xs">
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
                className="hover:text-ink underline"
              >
                {review.source}
              </a>
            ) : (
              review.source
            )}
          </p>
        </div>
        {responded ? (
          <span className="bg-cloud text-ash rounded-full px-2 py-0.5 text-xs">Replied</span>
        ) : null}
      </header>

      {review.comment ? (
        <p className="text-charcoal text-sm whitespace-pre-line">{review.comment}</p>
      ) : (
        <p className="text-ash text-sm italic">No comment.</p>
      )}

      {review.response ? (
        <div className="border-ink bg-cloud rounded-md border-l-2 px-3 py-2">
          <p className="text-ash text-xs font-medium tracking-wider uppercase">Your reply</p>
          <p className="text-charcoal mt-1 text-sm whitespace-pre-line">{review.response}</p>
        </div>
      ) : null}

      {recoverySent ? <p className="text-ash text-xs">Recovery offer sent.</p> : null}

      {!responded && canReply ? (
        open ? (
          <ReplyForm
            venueId={venueId}
            review={review}
            formAction={formAction}
            state={state}
            pending={pending}
            onCancel={() => setOpen(false)}
          />
        ) : (
          <div>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="border-hairline text-ink hover:border-ink rounded-md border px-3 py-1.5 text-sm"
            >
              Reply privately
            </button>
          </div>
        )
      ) : null}

      {!recoverySent && canRecover ? (
        recoveryOpen ? (
          <form action={recoveryAction} className="flex flex-col gap-2">
            <input type="hidden" name="review_id" value={review.id} />
            <input type="hidden" name="venue_id" value={venueId} />
            <textarea
              name="message"
              rows={3}
              maxLength={800}
              placeholder="Apologise + offer to make it right (e.g. dessert on us next time). The guest gets this directly by email."
              className="border-hairline rounded-md border px-3 py-2 text-sm outline-none focus:border-neutral-900"
              required
            />
            {recoveryState.status === "error" ? (
              <p role="alert" className="text-xs text-red-600">
                {recoveryState.message}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRecoveryOpen(false)}
                className="border-hairline text-ink hover:border-ink rounded-md border px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={recoveryPending}
                className="bg-coral rounded-md px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {recoveryPending ? "Sending…" : "Send recovery offer"}
              </button>
            </div>
          </form>
        ) : (
          <div>
            <button
              type="button"
              onClick={() => setRecoveryOpen(true)}
              className="border-coral/40 bg-coral/5 text-coral hover:border-coral rounded-md border px-3 py-1.5 text-sm"
            >
              Send recovery offer
            </button>
          </div>
        )
      ) : null}
    </li>
  );
}

// Extracted from ReviewRow so the textarea-pre-fill ref + "Suggest
// with AI" button don't clutter the row's main render. useActionState
// stays in the parent (its `state.status === "saved"` flip is what
// hides the form), so this component receives formAction/state/pending
// as props rather than minting its own.
function ReplyForm({
  venueId,
  review,
  formAction,
  state,
  pending,
  onCancel,
}: {
  venueId: string;
  review: Review;
  formAction: (formData: FormData) => void;
  state: RespondToReviewState;
  pending: boolean;
  onCancel: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [suggesting, startSuggest] = useTransition();
  const [suggestError, setSuggestError] = useState<string | null>(null);
  // Only internal reviews have an encrypted comment in our DB — Google
  // imports drop the comment text after sync. No comment = no draft.
  const canSuggest = review.source === "internal" && review.comment !== null;

  const onSuggest = () => {
    setSuggestError(null);
    startSuggest(async () => {
      const r = await suggestReplyDraft({ reviewId: review.id, venueId });
      if (!r.ok) {
        setSuggestError(r.error);
        return;
      }
      if (textareaRef.current) {
        textareaRef.current.value = r.draft;
        textareaRef.current.focus();
      }
    });
  };

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="review_id" value={review.id} />
      <input type="hidden" name="venue_id" value={venueId} />
      <textarea
        ref={textareaRef}
        name="reply"
        rows={3}
        maxLength={800}
        placeholder={
          review.source === "google"
            ? "Your reply will post publicly under this review on Google."
            : "Reply directly to the guest by email — they'll see this in their inbox."
        }
        className="border-hairline rounded-md border px-3 py-2 text-sm outline-none focus:border-neutral-900"
        required
      />
      {state.status === "error" ? (
        <p role="alert" className="text-xs text-red-600">
          {state.message}
        </p>
      ) : null}
      {suggestError ? (
        <p role="alert" className="text-xs text-red-600">
          {suggestError}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        {canSuggest ? (
          <button
            type="button"
            onClick={onSuggest}
            disabled={suggesting || pending}
            className="border-hairline text-ink hover:border-ink mr-auto rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {suggesting ? "Drafting…" : "Suggest with AI"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onCancel}
          className="border-hairline text-ink hover:border-ink rounded-md border px-3 py-1.5 text-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          className="bg-ink hover:bg-charcoal rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send reply"}
        </button>
      </div>
    </form>
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

function SentimentBadge({ sentiment }: { sentiment: "positive" | "neutral" | "negative" }) {
  const tone =
    sentiment === "positive"
      ? "bg-emerald-50 text-emerald-700"
      : sentiment === "negative"
        ? "bg-rose-50 text-rose-700"
        : "bg-cloud text-ash";
  const label =
    sentiment === "positive" ? "POSITIVE" : sentiment === "negative" ? "NEGATIVE" : "NEUTRAL";
  return (
    <span
      title="AI-classified sentiment"
      className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase ${tone}`}
    >
      {label}
    </span>
  );
}
