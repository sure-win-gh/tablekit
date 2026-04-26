"use client";

import { ArrowLeftRight, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/components/ui";

// Keyboard-driven venue picker.
//
// ⌘K (or Ctrl-K) opens a popover anchored to the trigger pill;
// arrows + Enter to navigate. Click-outside or Esc closes. The
// venue list is server-supplied — RLS already filtered it to
// what the operator can see, so a venue-scoped host never sees
// a peer's venue in the list.

type Venue = { id: string; name: string };

export function VenueSwitcher({
  currentVenueId,
  venues,
}: {
  currentVenueId: string;
  venues: Venue[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Don't render at all when there's nothing to switch to. Single
  // venue orgs (the common case today) never see this control.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (!open) return;
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % venues.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + venues.length) % venues.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const v = venues[highlight];
        if (v) {
          setOpen(false);
          router.push(`/dashboard/venues/${v.id}/bookings`);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, highlight, venues, router]);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const node = popoverRef.current;
      if (node && !node.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  if (venues.length < 2) return null;

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-pill border border-hairline bg-white px-2.5 py-1 text-xs font-semibold text-charcoal transition hover:border-ink hover:text-ink"
      >
        <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
        Switch venue
        <kbd className="ml-1 rounded border border-hairline bg-cloud px-1 text-[10px] font-mono text-ash">
          ⌘K
        </kbd>
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Switch venue"
          className="absolute right-0 top-full z-40 mt-1.5 w-64 rounded-card border border-hairline bg-white p-1 shadow-panel"
        >
          {venues.map((v, i) => {
            const isCurrent = v.id === currentVenueId;
            const isHi = i === highlight;
            return (
              <button
                key={v.id}
                type="button"
                role="option"
                aria-selected={isHi}
                onClick={() => {
                  setOpen(false);
                  router.push(`/dashboard/venues/${v.id}/bookings`);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-input px-3 py-2 text-left text-sm transition",
                  isHi ? "bg-cloud text-ink" : "text-charcoal hover:bg-cloud hover:text-ink",
                )}
              >
                <span className={cn(isCurrent && "font-semibold")}>{v.name}</span>
                {isCurrent ? (
                  <Check className="h-3.5 w-3.5 text-coral" aria-hidden />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
