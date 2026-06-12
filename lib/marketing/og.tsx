import { ImageResponse } from "next/og";

import { SITE } from "./site";

// Shared Open Graph card renderer (next/og — built into Next, no new dep).
// Produces a real, branded 1200×630 image per page: wordmark, optional
// eyebrow, the page headline, and the tagline. Not a fake screenshot —
// a designed card. Hex values are unavoidable here (Satori renders inline
// styles, not Tailwind) and mirror the brand tokens in globals.css.

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

export function renderOgImage({ title, eyebrow }: { title: string; eyebrow?: string }) {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#ffffff",
          padding: 80,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: "#ff385c" }} />
          <div style={{ fontSize: 34, fontWeight: 700, color: "#222222" }}>{SITE.name}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {eyebrow ? (
            <div
              style={{
                fontSize: 26,
                fontWeight: 600,
                color: "#ff385c",
                textTransform: "uppercase",
                letterSpacing: 2,
              }}
            >
              {eyebrow}
            </div>
          ) : null}
          <div
            style={{
              fontSize: 62,
              fontWeight: 700,
              color: "#222222",
              lineHeight: 1.1,
              maxWidth: 960,
            }}
          >
            {title}
          </div>
        </div>
        <div style={{ fontSize: 26, color: "#6a6a6a" }}>{SITE.tagline}</div>
      </div>
    ),
    { ...OG_SIZE },
  );
}
