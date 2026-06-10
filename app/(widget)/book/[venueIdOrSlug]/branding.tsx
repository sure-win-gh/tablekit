// Per-venue widget branding — the themed wrapper + header shared by the
// hosted booking page and the iframe embed. Server components (no client
// state); the brand CSS variables come pre-computed from the page via
// lib/branding/theme.ts widgetThemeStyle.

import type { CSSProperties, ReactNode } from "react";

// Applies the per-venue CSS-variable overrides to the whole booking
// subtree. Uses `display: contents` so it adds NO box — the embed's
// auto-height measurement (document scrollHeight) is unchanged, and the
// `<main>` underneath stays a direct flex child of the widget layout.
// Custom properties still inherit through a display:contents element, so
// every descendant `coral`/radius utility picks up the override.
//
// When `style` is undefined (Free/Core, or nothing to theme) it renders
// the children untouched so default Tablekit styling applies.
export function WidgetThemeProvider({
  style,
  children,
}: {
  style: CSSProperties | undefined;
  children: ReactNode;
}) {
  if (!style) return <>{children}</>;
  return (
    <div className="contents" style={style}>
      {children}
    </div>
  );
}

type HeaderVariant = "hosted" | "embed";

// Branding header: operator logo when present (Plus), else the venue-name
// wordmark — matching the per-variant type scale the two pages used inline
// before. The "Book a table" eyebrow (hosted only) is `text-coral`, so it
// now inherits the operator accent automatically.
export function WidgetHeader({
  venueName,
  logoUrl,
  dateLine,
  variant,
}: {
  venueName: string;
  logoUrl: string | null;
  // Optional sub-line. The wizard surfaces the chosen date via the summary
  // trail instead, so the booking pages omit it.
  dateLine?: string | undefined;
  variant: HeaderVariant;
}) {
  const hosted = variant === "hosted";
  return (
    <header>
      {hosted ? (
        <p className="text-coral text-xs font-semibold tracking-wider uppercase">Book a table</p>
      ) : null}
      {logoUrl ? (
        // Plain <img>, not next/image: operator logos are arbitrary HTTPS
        // hosts, and allow-listing https://** in the image optimizer would
        // let it proxy any URL (SSRF/abuse). CSP img-src https: permits it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt={venueName}
          loading="lazy"
          className={hosted ? "mt-2 h-12 w-auto" : "h-9 w-auto"}
        />
      ) : (
        <h1
          className={
            hosted
              ? "text-ink mt-2 text-4xl font-bold tracking-tight"
              : "text-ink text-2xl font-bold tracking-tight"
          }
        >
          {venueName}
        </h1>
      )}
      {dateLine ? (
        <p className={hosted ? "text-ash mt-1 text-sm" : "text-ash mt-0.5 text-xs"}>{dateLine}</p>
      ) : null}
    </header>
  );
}
