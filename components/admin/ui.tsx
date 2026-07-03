// Server-safe admin UI primitives — no client JS, just markup. Shared
// across every (admin) page so the cockpit reads as one surface
// instead of eight hand-rolled ones. Charts live in ./charts.tsx
// (client component, recharts).

import { Download } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Sparkline } from "@/components/admin/sparkline";
import { Card, CardBody, CardHeader, CardTitle, cn } from "@/components/ui";

// ---------------------------------------------------------------------------
// Card chrome with optional CSV link — same shape as the operator
// reports cards so both dashboards feel related.
// ---------------------------------------------------------------------------
export function Section({
  title,
  description,
  csvHref,
  children,
}: {
  title: string;
  description?: string;
  csvHref?: string;
  children: ReactNode;
}) {
  return (
    <Card padding="lg">
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description ? <p className="text-ash mt-0.5 text-xs">{description}</p> : null}
        </div>
        {csvHref ? (
          <a
            href={csvHref}
            className="rounded-pill border-hairline text-ink hover:border-ink inline-flex items-center gap-1.5 border bg-white px-3 py-1 text-xs font-semibold transition"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            CSV
          </a>
        ) : null}
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

export function Empty({ message }: { message: string }) {
  return <p className="text-ash text-xs">{message}</p>;
}

// ---------------------------------------------------------------------------
// KPI tile — headline number with optional sub-line, sparkline, and
// alert tint. The cockpit's unit of hierarchy.
// ---------------------------------------------------------------------------
export function KpiTile({
  label,
  value,
  sub,
  alert = false,
  sparkline,
}: {
  label: string;
  value: string;
  // `| undefined` so callers can pass conditional subs under
  // exactOptionalPropertyTypes.
  sub?: string | undefined;
  alert?: boolean;
  sparkline?: { day: string; n: number }[];
}) {
  return (
    <div className="rounded-card border-hairline shadow-panel border bg-white px-4 py-3">
      <div className="text-ash text-[11px] font-semibold tracking-wide uppercase">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-2xl font-bold tracking-tight tabular-nums",
          alert ? "text-rose" : "text-ink",
        )}
      >
        {value}
      </div>
      {sub ? <div className="text-ash text-[11px] tabular-nums">{sub}</div> : null}
      {sparkline && sparkline.length > 0 ? (
        <div className="mt-1">
          <Sparkline data={sparkline} />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alert strip — zero-noise by design: renders nothing when everything
// is healthy, a single row of linked warnings when it isn't.
// ---------------------------------------------------------------------------
export type AlertItem = { label: string; href: string };

export function AlertStrip({ items }: { items: AlertItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-card border-rose/40 bg-rose/5 flex flex-wrap items-center gap-2 border px-3 py-2">
      <span className="text-rose text-xs font-bold tracking-wide uppercase">Needs attention</span>
      {items.map((a) => (
        <Link
          key={a.label}
          href={a.href}
          className="rounded-pill border-rose/40 text-rose hover:bg-rose/10 border bg-white px-2.5 py-0.5 text-xs font-semibold transition"
        >
          {a.label}
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal comparison bar — adoption rates, mixes, failure counts.
// ---------------------------------------------------------------------------
export function HBar({
  label,
  value,
  max,
  display,
  sub,
  color = "var(--color-ink)",
}: {
  label: ReactNode;
  value: number;
  max: number;
  display: string;
  sub?: string | undefined;
  color?: string;
}) {
  // Zero stays zero — a visible sliver for an empty stage misleads.
  const width = max === 0 || value === 0 ? 0 : Math.max(2, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="text-ink w-56 shrink-0 truncate">{label}</span>
      <span className="bg-cloud relative h-4 flex-1 overflow-hidden rounded-[4px]">
        <span
          className="absolute inset-y-0 left-0 rounded-[4px]"
          style={{ width: `${width}%`, backgroundColor: color }}
          aria-hidden
        />
      </span>
      <span className="text-ink w-16 shrink-0 text-right font-semibold tabular-nums">
        {display}
      </span>
      {sub ? <span className="text-ash w-24 shrink-0 text-right tabular-nums">{sub}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status chip — small tinted label for statuses / action prefixes.
// Tones map to existing tokens only.
// ---------------------------------------------------------------------------
export type ChipTone = "neutral" | "ink" | "rose" | "coral";

const CHIP_TONES: Record<ChipTone, string> = {
  neutral: "border-hairline text-ash bg-white",
  ink: "border-ink/20 text-ink bg-cloud",
  rose: "border-rose/40 text-rose bg-rose/5",
  coral: "border-coral/40 text-coral-deep bg-coral/5",
};

export function Chip({ tone = "neutral", children }: { tone?: ChipTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-pill inline-flex items-center border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap",
        CHIP_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers.
// ---------------------------------------------------------------------------
export function gbp(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  return `${sign}£${(Math.abs(minor) / 100).toFixed(2)}`;
}

export function pctStr(rate: number, dp = 1): string {
  return `${(rate * 100).toFixed(dp)}%`;
}

// Relative time for admin tables ("3d ago" beats a raw ISO stamp when
// scanning fifty rows). Pure; exported for unit tests. Pair with a
// title attribute carrying the exact timestamp.
export function timeAgo(d: Date | null, now: Date = new Date()): string {
  if (!d) return "—";
  const ms = now.getTime() - d.getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function fmtDateTimeUtc(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// Shared table classes (kept as constants so pages stay consistent).
export const TABLE = "w-full text-xs";
export const THEAD = "text-ash text-left";
export const TBODY = "divide-hairline divide-y";
