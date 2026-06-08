// Per-venue widget theming — pure helpers that turn an operator's stored
// VenueBranding into CSS custom-property overrides for the booking surfaces.
//
// Why CSS variables: Tailwind v4 compiles `bg-coral` / `hover:bg-coral-deep`
// to `var(--color-coral)` / `var(--color-coral-deep)`. Redefining those
// variables on a wrapper element re-points every `coral` utility in the
// subtree — no per-component refactor. See lib/branding/theme.test or the
// widget pages for usage.
//
// No "server-only": this module is pure (no IO) so it stays unit-testable
// and importable from React Server Components. It takes a `gated` flag and
// returns `undefined` when theming shouldn't apply — the caller decides the
// gate (Plus plan) so this stays free of auth concerns.

import type { CSSProperties } from "react";

import type { VenueBranding } from "../messaging/context";

// Mirrors the canonical guard in lib/messaging/venue-settings.ts. Duplicated
// (not imported) so this module stays pure / server-only-free; the value is
// already hex-validated on the way in, this is belt-and-braces against any
// path that wrote venues.settings.branding directly.
const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Sharp corners: small-but-not-razor radii so buttons still read as buttons.
const SHARP_RADII: Record<string, string> = {
  "--radius-input": "2px",
  "--radius-card": "2px",
  "--radius-pill": "4px",
};

// "#abc" -> "#aabbcc". Assumes a HEX_COLOUR-valid input.
export function expandHex(hex: string): string {
  if (hex.length === 4) {
    const [, r, g, b] = hex;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return hex.toLowerCase();
}

// Deterministic darken for the hover/active shade, replacing the hand-tuned
// --color-coral-deep for operator colours. Multiplies each RGB channel by
// `factor` and clamps. Pure — no Math.random/Date.
export function deriveHoverShade(hex: string, factor = 0.82): string {
  const full = expandHex(hex);
  const channel = (start: number) => {
    const v = Math.round(parseInt(full.slice(start, start + 2), 16) * factor);
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

// Build the CSS-variable override object for the widget wrapper, or undefined
// when theming should not apply (Free/Core, or nothing to theme). `gated` is
// the Plus check, resolved by the caller.
export function widgetThemeStyle(
  branding: VenueBranding | undefined,
  opts: { gated: boolean },
): CSSProperties | undefined {
  if (!opts.gated || !branding) return undefined;

  const vars: Record<string, string> = {};

  if (branding.brandColour && HEX_COLOUR.test(branding.brandColour)) {
    vars["--color-coral"] = branding.brandColour;
    vars["--color-coral-deep"] = deriveHoverShade(branding.brandColour);
  }

  if (branding.cornerStyle === "sharp") {
    Object.assign(vars, SHARP_RADII);
  }

  if (Object.keys(vars).length === 0) return undefined;
  return vars as CSSProperties;
}
