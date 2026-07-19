"use client";

import { CalendarClock } from "lucide-react";
import dynamic from "next/dynamic";
import { useState, useSyncExternalStore } from "react";

import { CAL_LINK, DEMO_HREF, DEMO_IS_EXTERNAL } from "@/lib/marketing/site";
import {
  readSchedulerConsent,
  SCHEDULER_CONSENT_KEY,
  writeSchedulerConsent,
} from "@/lib/marketing/scheduler-consent";

// Consent-gated Cal.com embed (docs/specs/demo-scheduler.md). By default we
// render a branded placeholder + "Load scheduler" button and the link-out as a
// no-JS / no-consent fallback. Cal's script, iframe and cookies load ONLY once
// the visitor clicks (or has consented before) — the click is the consent.

// Lazily imported so the ~heavy embed chunk (and Cal's runtime) are never in the
// initial /demo bundle and only fetched when <Cal> actually renders, which we
// gate behind consent below. ssr:false — the embed is client-only.
const Cal = dynamic(() => import("@calcom/embed-react"), {
  ssr: false,
  loading: () => <SchedulerFrame>Loading scheduler…</SchedulerFrame>,
});

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function subscribe(notify: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === SCHEDULER_CONSENT_KEY) notify();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

function getConsentSnapshot(): boolean {
  return readSchedulerConsent(safeLocalStorage());
}

// Server + first client paint: never consented, so the placeholder (not the
// embed) is what SSR emits — the no-JS fallback link is in the initial HTML and
// no Cal request is made before hydration. Mirrors components/cookie-notice.tsx.
function getConsentServerSnapshot(): boolean {
  return false;
}

export function DemoScheduler() {
  const consented = useSyncExternalStore(subscribe, getConsentSnapshot, getConsentServerSnapshot);
  const [clicked, setClicked] = useState(false);
  const show = consented || clicked;

  function load() {
    setClicked(true);
    const storage = safeLocalStorage();
    writeSchedulerConsent(storage);
    // Safari only fires `storage` in other tabs — nudge a re-read in this one so
    // a second mount of the island on the page reflects the choice.
    try {
      window.dispatchEvent(
        new StorageEvent("storage", { key: SCHEDULER_CONSENT_KEY, newValue: "1" }),
      );
    } catch {
      // StorageEvent construction can throw in old browsers — harmless; the
      // local `clicked` state already reveals the embed this session.
    }
  }

  if (show) {
    return (
      <SchedulerFrame>
        <Cal
          calLink={CAL_LINK}
          style={{ width: "100%", height: "100%", overflow: "scroll" }}
          config={{ layout: "month_view" }}
        />
      </SchedulerFrame>
    );
  }

  return (
    <div className="border-hairline rounded-card flex flex-col items-center gap-4 border border-dashed bg-white p-8 text-center">
      <CalendarClock className="text-coral h-8 w-8" aria-hidden />
      <div className="flex flex-col gap-1.5">
        <p className="text-ink font-semibold">Book straight from this page</p>
        <p className="text-ash max-w-sm text-sm text-pretty">
          The scheduler is a third-party embed (Cal.com). We load it — and its cookies — only when
          you choose to, so nothing third-party runs until you click.
        </p>
      </div>
      <button
        type="button"
        onClick={load}
        className="bg-ink hover:bg-charcoal rounded-pill px-5 py-2.5 text-sm font-semibold text-white transition"
      >
        Load scheduler
      </button>
      {/* No-JS / no-consent fallback — always in the DOM so the demo is bookable
          without ever loading the embed. */}
      <p className="text-ash text-xs">
        Or{" "}
        <a
          href={DEMO_HREF}
          {...(DEMO_IS_EXTERNAL ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="text-coral font-semibold hover:underline"
        >
          book without loading the embed
        </a>
        .
      </p>
    </div>
  );
}

function SchedulerFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-hairline rounded-card h-[640px] w-full overflow-hidden border bg-white">
      {children}
    </div>
  );
}
