"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore } from "react";

import { cn } from "@/components/ui";

// Privacy / cookie notice shown on the marketing and widget surfaces.
//
// We're notice-only, not consent-gated: TableKit doesn't run optional
// trackers — only a first-party session cookie on sign-in (necessary
// under PECR, no consent required). The banner exists for compliance
// signalling and so users know what to expect. Dismiss persists in
// localStorage; the banner doesn't re-appear unless storage is cleared.

const ACK_KEY = "tablekit:cookie-ack";
const ACK_VALUE = "1";

// Subscribe React's render to a localStorage-backed boolean via
// useSyncExternalStore — that's the rule-compliant way to "render
// from external state" without setState-in-effect. The store is a
// no-op subscription (we only need a one-shot read at mount); the
// storage event listener catches cross-tab dismisses for free.
function subscribe(notify: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === ACK_KEY) notify();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

function getAck(): string | null {
  try {
    return window.localStorage.getItem(ACK_KEY);
  } catch {
    // Some embed contexts (Safari private, sandboxed iframes) throw
    // on storage access. Treat as "not acknowledged" so the user
    // sees the notice; dismiss will then no-op silently.
    return null;
  }
}

// Server snapshot — render nothing pre-hydration. The post-hydrate
// client snapshot decides whether the banner shows.
function getServerSnapshot(): string | null {
  return ACK_VALUE;
}

export function CookieNotice() {
  const ack = useSyncExternalStore(subscribe, getAck, getServerSnapshot);
  const visible = ack !== ACK_VALUE;

  function dismiss() {
    try {
      window.localStorage.setItem(ACK_KEY, ACK_VALUE);
      // Safari only fires the `storage` event in *other* tabs; trigger
      // a re-read in this tab too.
      window.dispatchEvent(new StorageEvent("storage", { key: ACK_KEY, newValue: ACK_VALUE }));
    } catch {
      // No storage available — banner stays. The user can ignore it
      // or close the tab; nothing we can persist anyway.
    }
  }

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Cookies and privacy"
      className={cn(
        "rounded-card border-hairline shadow-panel fixed inset-x-3 bottom-3 z-50 mx-auto max-w-2xl border bg-white p-4",
        "sm:p-5",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-charcoal flex flex-col gap-1.5 text-sm">
          <p className="text-ink font-semibold">Cookies and your privacy</p>
          <p className="text-xs leading-relaxed">
            TableKit uses a single first-party cookie to keep operators signed in. We don&apos;t run
            third-party analytics or advertising trackers. Read the full{" "}
            <Link
              href="/privacy"
              className="text-ink hover:text-coral font-semibold underline underline-offset-4"
            >
              privacy notice
            </Link>
            .
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="text-ash hover:bg-cloud hover:text-ink -mt-1 -mr-1 rounded-full p-1.5 transition"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
