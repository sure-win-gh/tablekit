"use client";

import { useEffect } from "react";

// Mounts inside the iframe. Posts the document's content height to
// window.parent on every layout change so the parent page's loader
// script can size the iframe to fit. Height-only — we never send
// PII or any other payload.
//
// frameId is read from the location hash (set by the loader so it
// can route incoming messages to the right iframe when one page
// embeds multiple widgets).

export function EmbedAutoHeight() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.parent === window) return; // not iframed; no-op

    const frameId = readFrameIdFromHash();

    const send = () => {
      const height = document.documentElement.scrollHeight;
      window.parent.postMessage(
        { type: "tablekit:resize", frameId, height },
        "*", // parent origin is unknown by design — embedded into 3p sites
      );
    };

    // Initial post + observe future changes.
    send();
    const ro = new ResizeObserver(() => send());
    ro.observe(document.documentElement);

    return () => ro.disconnect();
  }, []);

  return null;
}

function readFrameIdFromHash(): string {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash.replace(/^#/, "");
  for (const part of hash.split("&")) {
    const [k, v] = part.split("=");
    if (k === "frameId" && v) return decodeURIComponent(v);
  }
  return "";
}
