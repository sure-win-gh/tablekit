// Server-rendered progress + summary trail for the booking wizard. The
// summary chips are plain <a> links to the clear-forward URL (edit a step →
// drop that step and all later ones), so editing works with no JS. Built with
// the same buildStepUrl the client steps use.

import { cn } from "@/components/ui";
import { formatVenueDateLong } from "@/lib/bookings/time";
import { buildStepUrl, type WizardParams, type WizardStep } from "@/lib/public/wizard-step";

const STEP_INDEX: Record<WizardStep, number> = { party: 1, date: 2, time: 3, details: 4 };

export function StepProgress({ step }: { step: WizardStep }) {
  const n = STEP_INDEX[step];
  return (
    <div role="group" aria-label={`Step ${n} of 4`} className="flex items-center gap-2">
      <span className="text-ash text-xs font-semibold tracking-wide uppercase">Step {n} of 4</span>
      <span className="flex gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn(
              "h-1.5 w-6 rounded-full",
              i < n ? "bg-coral" : i === n ? "bg-ink" : "bg-hairline",
            )}
          />
        ))}
      </span>
    </div>
  );
}

export function SummaryTrail({
  basePath,
  step,
  params,
  timezone,
}: {
  basePath: string;
  step: WizardStep;
  params: WizardParams;
  timezone: string;
}) {
  const href = (p: WizardParams) => {
    const qs = buildStepUrl(p);
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const chips: { key: string; label: string; href: string }[] = [];
  if (step !== "party" && params.party != null) {
    // edit party → clear everything
    chips.push({
      key: "party",
      label: `${params.party} ${params.party === 1 ? "guest" : "guests"}`,
      href: href({}),
    });
  }
  if ((step === "time" || step === "details") && params.date) {
    // edit date → keep party
    chips.push({
      key: "date",
      label: formatVenueDateLong(new Date(`${params.date}T12:00:00Z`), { timezone }),
      href: href({ party: params.party }),
    });
  }
  if (step === "details" && params.wallStart) {
    // edit time → keep party + date (+ its month)
    chips.push({
      key: "time",
      label: params.wallStart,
      href: href({ party: params.party, date: params.date, month: params.date?.slice(0, 7) }),
    });
  }
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <a
          key={c.key}
          href={c.href}
          className="border-hairline text-charcoal hover:border-ink inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition"
        >
          {c.label}
          <span aria-hidden className="text-ash">
            ✎
          </span>
          <span className="sr-only">— change</span>
        </a>
      ))}
    </div>
  );
}
