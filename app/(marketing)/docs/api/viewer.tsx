"use client";

// Stoplight Elements wrapper.
//
// Loads the web-component bundle from the unpkg CDN at runtime;
// once loaded, `<elements-api>` is a registered custom element.
// React doesn't typecheck custom elements by default, so we cast
// to a generic intrinsic via the JSX namespace augmentation
// below — keeps the component-tree readable without importing
// any additional types.

import Script from "next/script";
import type React from "react";

// React 19 + Next 16 uses React.JSX (not the global JSX namespace)
// for IntrinsicElements augmentation. Augmenting the wrong one is
// a silent no-op. The eslint disable is the standard escape hatch
// for ambient declarations of custom elements — there's no
// non-namespace path to augment React's JSX shape.
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "elements-api": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          apiDescriptionUrl?: string;
          router?: "hash" | "memory" | "history";
          layout?: "sidebar" | "stacked";
          tryItCredentialsPolicy?: "omit" | "include" | "same-origin";
        },
        HTMLElement
      >;
    }
  }
}

export function ApiDocsViewer() {
  return (
    <>
      {/* Stoplight Elements assets — loaded once, registers the
          custom element globally. Pinned to a major version so a
          breaking release upstream doesn't silently change our
          docs page. */}
      <link rel="stylesheet" href="https://unpkg.com/@stoplight/elements@8/styles.min.css" />
      <Script
        src="https://unpkg.com/@stoplight/elements@8/web-components.min.js"
        strategy="afterInteractive"
      />
      <main className="flex min-h-screen flex-col">
        <elements-api
          apiDescriptionUrl="/api/v1/openapi.json"
          router="hash"
          layout="sidebar"
          tryItCredentialsPolicy="omit"
        />
      </main>
    </>
  );
}
