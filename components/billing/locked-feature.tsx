import { Lock } from "lucide-react";
import Link from "next/link";

import { Badge, Button } from "@/components/ui";
import { FEATURES, type Feature } from "@/lib/auth/entitlements";
import type { Plan } from "@/lib/auth/plan-level";

const PLAN_LABEL: Record<Plan, string> = {
  free: "Free",
  core: "Core",
  plus: "Plus",
};

// Show-but-lock paywall surface for a whole feature page. Renders a
// blurred placeholder teaser of "what's behind here" with a centred
// upgrade card on top. Static (no client JS) so it can't be dismissed
// to reveal anything, and it renders no real data — the page returns
// this BEFORE running any gated query. See
// docs/specs/plan-gating-paywall.md.
//
// For gating one section inside an otherwise-free page (e.g. the
// SMS/WhatsApp block in Settings), use <UpgradeBanner> instead — that
// keeps the surrounding free content usable.
export function LockedFeature({ feature, currentPlan }: { feature: Feature; currentPlan: Plan }) {
  const meta = FEATURES[feature];
  const href = `/dashboard/upgrade?feature=${feature}`;
  void currentPlan;

  return (
    <div className="relative isolate min-h-[420px]">
      {/* Blurred teaser — purely decorative, never real data. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 flex flex-col gap-4 p-1 blur-[5px] select-none"
      >
        <div className="grid grid-cols-3 gap-4">
          <PlaceholderStat />
          <PlaceholderStat />
          <PlaceholderStat />
        </div>
        <PlaceholderChart />
        <PlaceholderRows rows={5} />
      </div>

      {/* Upgrade card. */}
      <div className="flex min-h-[420px] items-center justify-center p-4">
        <div className="rounded-card border-hairline shadow-panel flex max-w-sm flex-col items-center gap-3 border bg-white p-6 text-center">
          <span className="bg-coral/10 text-coral inline-flex h-10 w-10 items-center justify-center rounded-full">
            <Lock className="h-5 w-5" aria-hidden />
          </span>
          <Badge tone="coral">{PLAN_LABEL[meta.minPlan]}</Badge>
          <h2 className="text-ink text-lg font-bold tracking-tight">
            Upgrade to unlock {meta.label}
          </h2>
          <p className="text-charcoal text-sm">{meta.blurb}</p>
          <Link href={href} className="mt-1">
            <Button variant="primary" size="md">
              Upgrade to {PLAN_LABEL[meta.minPlan]}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

// Slim inline upsell for gating one section without hiding the free
// content around it. Used above the messaging form in Settings.
export function UpgradeBanner({ feature }: { feature: Feature }) {
  const meta = FEATURES[feature];
  return (
    <div className="rounded-card border-coral/30 bg-coral/5 mb-4 flex flex-wrap items-center justify-between gap-3 border p-3">
      <div className="flex items-center gap-2">
        <Lock className="text-coral h-4 w-4 shrink-0" aria-hidden />
        <p className="text-charcoal text-sm">
          <span className="text-ink font-semibold">{meta.label}</span> {meta.blurb}
        </p>
      </div>
      <Link href={`/dashboard/upgrade?feature=${feature}`}>
        <Button variant="primary" size="sm">
          Upgrade to {PLAN_LABEL[meta.minPlan]}
        </Button>
      </Link>
    </div>
  );
}

// --- Decorative placeholders (aria-hidden, no data) ---------------------

function PlaceholderStat() {
  return (
    <div className="rounded-card border-hairline bg-cloud flex flex-col gap-2 border p-4">
      <div className="bg-hairline h-6 w-12 rounded" />
      <div className="bg-hairline/70 h-3 w-20 rounded" />
    </div>
  );
}

function PlaceholderChart() {
  const bars = [60, 38, 72, 45, 88, 30, 64, 52];
  return (
    <div className="rounded-card border-hairline flex h-40 items-end gap-2 border bg-white p-4">
      {bars.map((h, i) => (
        <div key={i} className="bg-coral/30 flex-1 rounded-t" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

function PlaceholderRows({ rows }: { rows: number }) {
  return (
    <div className="divide-hairline rounded-card border-hairline divide-y border bg-white">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="flex flex-col gap-1.5">
            <div className="bg-hairline h-3 w-32 rounded" />
            <div className="bg-hairline/70 h-2.5 w-20 rounded" />
          </div>
          <div className="bg-hairline/70 h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}
