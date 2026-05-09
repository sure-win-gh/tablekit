"use client";

// Client forms for webhook subscriptions: create + revoke.
//
// The create form has two modes: "form" (operator types url/label
// + ticks events) and "reveal" (server returned the plaintext
// secret; show once with copy-to-clipboard). Same UX pattern as
// the api-keys page.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { WEBHOOK_EVENTS, type WebhookEvent } from "@/lib/webhooks/events";

import { createSubscriptionAction, revokeSubscriptionAction } from "./actions";

export function CreateSubscriptionForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [events, setEvents] = useState<Set<WebhookEvent>>(new Set());
  const [revealed, setRevealed] = useState<{ secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  if (revealed) {
    return (
      <div className="rounded-card border border-amber-200 bg-amber-50 p-4">
        <h3 className="text-sm font-semibold text-amber-900">
          Copy this signing secret now — it won&apos;t be shown again
        </h3>
        <p className="mt-1 text-xs text-amber-800">
          Use it to verify <code>X-TableKit-Signature</code> on incoming deliveries. We only store
          an encrypted copy. Lost? Revoke and create a new subscription.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 rounded border border-amber-300 bg-white px-3 py-2 font-mono text-xs break-all">
            {revealed.secret}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(revealed.secret).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
            className="rounded-card bg-ink hover:bg-ink/90 px-3 py-2 text-xs font-medium text-white transition"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            setRevealed(null);
            setUrl("");
            setLabel("");
            setEvents(new Set());
            setError(null);
            router.refresh();
          }}
          className="text-ash hover:text-ink mt-3 text-xs underline"
        >
          I&apos;ve copied it — dismiss
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        if (events.size === 0) {
          setError("Select at least one event.");
          return;
        }
        startTransition(async () => {
          const r = await createSubscriptionAction({
            url,
            label,
            events: [...events],
          });
          if (!r.ok) {
            setError(r.error);
            return;
          }
          setRevealed({ secret: r.plaintextSecret });
        });
      }}
      className="flex flex-col gap-3"
    >
      <label className="flex flex-col gap-1">
        <span className="text-ash text-xs font-medium tracking-wide uppercase">URL (https)</span>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/tablekit-webhook"
          required
          className="rounded-card border-hairline focus:border-ink border bg-white px-3 py-2 text-sm outline-none"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-ash text-xs font-medium tracking-wide uppercase">
          Label (e.g. &quot;Loyalty sync&quot;)
        </span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={80}
          required
          className="rounded-card border-hairline focus:border-ink border bg-white px-3 py-2 text-sm outline-none"
        />
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-ash text-xs font-medium tracking-wide uppercase">Events</legend>
        <div className="flex flex-col gap-1">
          {WEBHOOK_EVENTS.map((ev) => (
            <label key={ev} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={events.has(ev)}
                onChange={(e) => {
                  setEvents((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(ev);
                    else next.delete(ev);
                    return next;
                  });
                }}
              />
              <code className="font-mono text-xs">{ev}</code>
            </label>
          ))}
        </div>
      </fieldset>
      {error ? (
        <p className="rounded-card bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-card bg-ink hover:bg-ink/90 self-start px-4 py-2 text-sm font-medium text-white transition disabled:bg-stone-400"
      >
        {pending ? "Creating…" : "Create subscription"}
      </button>
    </form>
  );
}

export function RevokeSubscriptionButton({
  subscriptionId,
  label,
}: {
  subscriptionId: string;
  label: string;
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
          if (!confirm(`Revoke "${label}"? Future deliveries will stop immediately.`)) return;
          setError(null);
          startTransition(async () => {
            const r = await revokeSubscriptionAction({ subscriptionId });
            if (!r.ok) {
              setError(r.error);
              return;
            }
            router.refresh();
          });
        }}
        className="rounded-card border border-red-200 px-3 py-1 text-xs text-red-700 transition hover:bg-red-50 disabled:opacity-50"
      >
        {pending ? "Revoking…" : "Revoke"}
      </button>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
