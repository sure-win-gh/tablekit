"use client";

// Client components for the API keys page.
//
// CreateKeyForm has two modes:
//   - "form"   — operator types a label, clicks Create.
//   - "reveal" — server returned the plaintext; render once with a
//                copy-to-clipboard button + a strong "this is the
//                only time you'll see this" warning. Dismiss returns
//                to "form" and refreshes the list.
//
// We hold the plaintext in component state for as long as the reveal
// panel is open. It never leaves this client component — no other
// component receives it via props or context.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { issueKeyAction, revokeKeyAction } from "./actions";

export function CreateKeyForm() {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [revealed, setRevealed] = useState<{ plaintext: string; prefix: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  if (revealed) {
    return (
      <div className="rounded-card border border-amber-200 bg-amber-50 p-4">
        <h3 className="text-sm font-semibold text-amber-900">
          Copy this key now — it won&apos;t be shown again
        </h3>
        <p className="mt-1 text-xs text-amber-800">
          We only store a hash of the key. If you lose it, revoke and create a new one.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 rounded border border-amber-300 bg-white px-3 py-2 font-mono text-xs break-all">
            {revealed.plaintext}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(revealed.plaintext).then(() => {
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
            setLabel("");
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
        startTransition(async () => {
          const r = await issueKeyAction({ label });
          if (!r.ok) {
            setError(r.error);
            return;
          }
          setRevealed({ plaintext: r.plaintext, prefix: r.prefix });
        });
      }}
      className="flex flex-col gap-3"
    >
      <label className="flex flex-col gap-1">
        <span className="text-ash text-xs font-medium tracking-wide uppercase">
          Label (e.g. &quot;Mailchimp sync&quot;)
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
      {error ? (
        <p className="rounded-card bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-card bg-ink hover:bg-ink/90 self-start px-4 py-2 text-sm font-medium text-white transition disabled:bg-stone-400"
      >
        {pending ? "Creating…" : "Create key"}
      </button>
    </form>
  );
}

export function RevokeKeyButton({ keyId, label }: { keyId: string; label: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!confirm(`Revoke "${label}"? Any integration using this key will stop working.`)) {
            return;
          }
          setError(null);
          startTransition(async () => {
            const r = await revokeKeyAction({ keyId });
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
