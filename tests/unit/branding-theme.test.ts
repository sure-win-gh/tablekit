import { describe, expect, it } from "vitest";

import { deriveHoverShade, expandHex, widgetThemeStyle } from "@/lib/branding/theme";

describe("expandHex", () => {
  it("expands #abc to #aabbcc", () => {
    expect(expandHex("#abc")).toBe("#aabbcc");
  });

  it("lowercases and passes through a full hex", () => {
    expect(expandHex("#1D4ED8")).toBe("#1d4ed8");
  });
});

describe("deriveHoverShade", () => {
  it("darkens each channel deterministically", () => {
    // #ff385c -> round(255*0.82)=209=d1, round(56*0.82)=46=2e, round(92*0.82)=75=4b
    expect(deriveHoverShade("#ff385c")).toBe("#d12e4b");
  });

  it("handles shorthand hex and clamps to two digits", () => {
    expect(deriveHoverShade("#fff")).toBe("#d1d1d1");
    expect(deriveHoverShade("#000")).toBe("#000000");
  });
});

describe("widgetThemeStyle", () => {
  it("returns undefined when not gated (Free/Core)", () => {
    expect(widgetThemeStyle({ brandColour: "#1d4ed8" }, { gated: false })).toBeUndefined();
  });

  it("returns undefined when branding is absent", () => {
    expect(widgetThemeStyle(undefined, { gated: true })).toBeUndefined();
  });

  it("sets accent + derived hover shade when gated with a brand colour", () => {
    const style = widgetThemeStyle({ brandColour: "#1d4ed8" }, { gated: true }) as Record<
      string,
      string
    >;
    expect(style["--color-coral"]).toBe("#1d4ed8");
    expect(style["--color-coral-deep"]).toBe(deriveHoverShade("#1d4ed8"));
  });

  it("adds sharp radii overrides when cornerStyle is sharp", () => {
    const style = widgetThemeStyle(
      { brandColour: "#1d4ed8", cornerStyle: "sharp" },
      { gated: true },
    ) as Record<string, string>;
    expect(style["--radius-pill"]).toBe("4px");
    expect(style["--radius-card"]).toBe("2px");
  });

  it("does not add radii overrides for rounded corner style", () => {
    const style = widgetThemeStyle(
      { brandColour: "#1d4ed8", cornerStyle: "rounded" },
      { gated: true },
    ) as Record<string, string>;
    expect(style["--radius-pill"]).toBeUndefined();
  });

  it("drops a non-hex brand colour (injection guard) and returns undefined when nothing themable", () => {
    expect(
      widgetThemeStyle({ brandColour: "red; background:url(x)" }, { gated: true }),
    ).toBeUndefined();
  });

  it("themes corners even when no brand colour is set", () => {
    const style = widgetThemeStyle({ cornerStyle: "sharp" }, { gated: true }) as Record<
      string,
      string
    >;
    expect(style["--radius-pill"]).toBe("4px");
    expect(style["--color-coral"]).toBeUndefined();
  });
});
