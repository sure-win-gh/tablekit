"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition, type MouseEvent, type ReactNode } from "react";

import { cn } from "@/components/ui";
import { monthGridDays } from "@/lib/services/calendar";
import { addMonths, buildStepUrl, type WizardParams } from "@/lib/public/wizard-step";
import type { MonthAvailability } from "@/lib/public/venue";

type SlotLite = { serviceId: string; serviceName: string; wallStart: string };
type LinkProps = { href: string; onClick: (e: MouseEvent<HTMLAnchorElement>) => void };

// Each step choice is a real <a href> (works pre-hydration / no-JS), enhanced
// with a soft client transition + pending state. The href is built from the
// same buildStepUrl the server uses, so client + server URLs match exactly.
function useWizardNav(): { linkProps: (p: WizardParams) => LinkProps; pending: boolean } {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const base = pathname ?? "";
  const linkProps = (params: WizardParams): LinkProps => {
    const qs = buildStepUrl(params);
    // qs is always non-empty in practice (every nav carries at least party);
    // the bare-base fallback matches the server's empty-params edit URL.
    const href = qs ? `${base}?${qs}` : base;
    return {
      href,
      onClick: (e) => {
        // Let modified clicks (new tab etc.) fall through to the browser.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        startTransition(() => router.push(href));
      },
    };
  };
  return { linkProps, pending };
}

function StepShell({
  pending,
  title,
  children,
}: {
  pending: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      aria-busy={pending}
      className={cn(
        "flex flex-col gap-4 transition-opacity motion-reduce:transition-none",
        pending && "pointer-events-none opacity-60",
      )}
    >
      <h2 className="text-ink text-lg font-bold tracking-tight">{title}</h2>
      {children}
    </div>
  );
}

const PILL =
  "rounded-input border-hairline text-ink hover:border-ink focus-visible:ring-ink flex items-center justify-center border py-3 text-base font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transition-none";

// ---------------------------------------------------------------------------
// Step 1 — Party size
// ---------------------------------------------------------------------------
export function PartyStep() {
  const { linkProps, pending } = useWizardNav();
  const [showLarge, setShowLarge] = useState(false);
  const [large, setLarge] = useState(9);
  return (
    <StepShell pending={pending} title="How many guests?">
      <div className="grid grid-cols-4 gap-2">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
          <a key={n} {...linkProps({ party: n })} className={PILL}>
            {n}
          </a>
        ))}
      </div>
      {showLarge ? (
        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink font-medium">Guests (9–20)</span>
            <input
              type="number"
              min={9}
              max={20}
              value={large}
              onChange={(e) => setLarge(Math.max(9, Math.min(20, Number(e.target.value) || 9)))}
              className="border-hairline w-24 rounded-md border px-3 py-2 text-sm"
            />
          </label>
          <a
            {...linkProps({ party: large })}
            className="bg-ink hover:bg-charcoal rounded-md px-4 py-2 text-sm font-medium text-white transition"
          >
            Continue →
          </a>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowLarge(true)}
          className="text-coral self-start text-sm font-medium underline underline-offset-2"
        >
          Larger party (9–20) ›
        </button>
      )}
    </StepShell>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Date (stylised month calendar)
// ---------------------------------------------------------------------------
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function DateStep({
  party,
  monthAvailability,
  minMonth,
  maxMonth,
  venueKey,
}: {
  party: number;
  monthAvailability: MonthAvailability;
  minMonth: string;
  maxMonth: string;
  // Venue id-or-slug for building /events/<venue>/<event> deep-links.
  venueKey: string;
}) {
  const { linkProps, pending } = useWizardNav();
  return (
    <StepShell pending={pending} title="Which day?">
      <MonthCalendar
        month={monthAvailability.month}
        days={monthAvailability.days}
        events={monthAvailability.events}
        eventHref={(slug) => `/events/${venueKey}/${slug}`}
        minMonth={minMonth}
        maxMonth={maxMonth}
        dayLink={(ymd) => linkProps({ party, date: ymd, month: ymd.slice(0, 7) })}
        monthLink={(m) => linkProps({ party, month: m })}
      />
    </StepShell>
  );
}

function MonthCalendar({
  month,
  days,
  events,
  eventHref,
  minMonth,
  maxMonth,
  dayLink,
  monthLink,
}: {
  month: string;
  days: MonthAvailability["days"];
  events: MonthAvailability["events"];
  eventHref: (slug: string) => string;
  minMonth: string;
  maxMonth: string;
  dayLink: (ymd: string) => LinkProps;
  monthLink: (m: string) => LinkProps;
}) {
  const weeks = monthGridDays(`${month}-01`);
  const monthLabel = new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
  const prevMonth = addMonths(month, -1);
  const nextMonth = addMonths(month, 1);
  const canGoBack = prevMonth >= minMonth;
  const canGoForward = nextMonth <= maxMonth;
  const navBtn =
    "border-hairline text-ink hover:border-ink rounded border px-2 py-1 text-sm transition";
  const navDisabled = cn(navBtn, "text-stone opacity-30");
  const cellBase =
    "rounded-input flex aspect-square items-center justify-center text-sm tabular-nums transition motion-reduce:transition-none";

  return (
    <div className="border-hairline rounded-card flex flex-col gap-2 border p-3">
      <div className="flex items-center justify-between">
        {canGoBack ? (
          <a {...monthLink(prevMonth)} aria-label="Previous month" className={navBtn}>
            ←
          </a>
        ) : (
          <span aria-hidden className={navDisabled}>
            ←
          </span>
        )}
        <span className="text-ink text-sm font-semibold">{monthLabel}</span>
        {canGoForward ? (
          <a {...monthLink(nextMonth)} aria-label="Next month" className={navBtn}>
            →
          </a>
        ) : (
          <span aria-hidden className={navDisabled}>
            →
          </span>
        )}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {DOW_LABELS.map((d) => (
          <div key={d} className="text-ash pb-1 text-center text-[11px] font-medium">
            {d}
          </div>
        ))}
        {weeks.flat().map((ymd, i) => {
          if (ymd == null) return <div key={`pad-${i}`} aria-hidden />;
          const status = days[ymd] ?? "closed";
          const dayNum = Number(ymd.slice(8, 10));
          if (status === "open") {
            return (
              <a
                key={ymd}
                {...dayLink(ymd)}
                aria-label={`${dayNum}, available`}
                className={cn(cellBase, "border-hairline text-ink hover:border-ink border")}
              >
                {dayNum}
              </a>
            );
          }
          if (status === "event") {
            const ev = events[ymd];
            if (ev) {
              return (
                <a
                  key={ymd}
                  href={eventHref(ev.slug)}
                  aria-label={`${dayNum}, ${ev.name} — special event`}
                  className={cn(
                    cellBase,
                    "border-coral/40 text-coral-deep bg-coral/5 hover:border-coral border",
                  )}
                >
                  {dayNum}
                </a>
              );
            }
          }
          const word = status === "full" ? "fully booked" : status;
          return (
            <span
              key={ymd}
              aria-label={`${dayNum}, ${word}`}
              className={cn(
                cellBase,
                "text-stone cursor-default border border-transparent",
                status === "full" && "line-through",
              )}
            >
              {dayNum}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Time
// ---------------------------------------------------------------------------
export function TimeStep({
  party,
  date,
  slots,
}: {
  party: number;
  date: string;
  slots: SlotLite[];
}) {
  const { linkProps, pending } = useWizardNav();
  const month = date.slice(0, 7);
  const byService = new Map<string, SlotLite[]>();
  for (const s of slots) {
    const list = byService.get(s.serviceName) ?? [];
    list.push(s);
    byService.set(s.serviceName, list);
  }
  return (
    <StepShell pending={pending} title="What time?">
      {slots.length === 0 ? (
        <p className="rounded-card border-hairline text-ash border border-dashed p-4 text-sm">
          Sorry, nothing available that day for {party} {party === 1 ? "guest" : "guests"}. Pick
          another day or change the party size.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {[...byService.entries()].map(([svc, list]) => (
            <div key={svc}>
              <h3 className="text-ink text-sm font-semibold tracking-tight">{svc}</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {list.map((s) => (
                  <a
                    key={`${s.serviceId}-${s.wallStart}`}
                    {...linkProps({
                      party,
                      date,
                      month,
                      serviceId: s.serviceId,
                      wallStart: s.wallStart,
                    })}
                    className="rounded-input border-hairline text-ink hover:border-ink border px-3 py-1.5 text-sm font-semibold tabular-nums transition motion-reduce:transition-none"
                  >
                    {s.wallStart}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </StepShell>
  );
}
