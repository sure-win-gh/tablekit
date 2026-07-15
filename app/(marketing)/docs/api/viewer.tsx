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
          children?: React.ReactNode;
        },
        HTMLElement
      >;
    }
  }
}

// Exact-version pin + SRI. A floating @8 tag meant unpkg could serve
// us a new (or tampered) bundle at any time; with the integrity
// attribute the browser refuses anything that doesn't hash-match the
// build we reviewed. Bumping the version REQUIRES recomputing both
// hashes:
//   curl -sL https://unpkg.com/@stoplight/elements@<v>/<file> \
//     | openssl dgst -sha384 -binary | openssl base64 -A
const ELEMENTS_VERSION = "8.5.2";
const SCRIPT_SRI = "sha384-Wy+FsmLS9ZgiQK/ODulQPSA9zg+xHduMLnVEy+vZeGqwi1FKQ8/dKmsE38c0ovx/";
const STYLES_SRI = "sha384-oYu9Au1JU1Sd5Za5LYSepn+Sofm8uvVdUCxLWbJYesNAS72Y7G/gQ0pjiB6wyf1Z";

export function ApiDocsViewer() {
  return (
    <>
      <link
        rel="stylesheet"
        href={`https://unpkg.com/@stoplight/elements@${ELEMENTS_VERSION}/styles.min.css`}
        integrity={STYLES_SRI}
        crossOrigin="anonymous"
      />
      <Script
        src={`https://unpkg.com/@stoplight/elements@${ELEMENTS_VERSION}/web-components.min.js`}
        integrity={SCRIPT_SRI}
        crossOrigin="anonymous"
        strategy="afterInteractive"
      />
      <main className="flex min-h-screen flex-col">
        {/* Until (or unless) the CDN bundle registers the custom
            element, the fallback paragraph inside it is what renders —
            unknown elements display their children. So a CDN outage,
            an SRI mismatch, or JS disabled all degrade to a working
            link to the raw spec instead of a blank page. */}
        <elements-api
          apiDescriptionUrl="/api/v1/openapi.json"
          router="hash"
          layout="sidebar"
          tryItCredentialsPolicy="omit"
        >
          <p className="text-ash p-6 text-sm">
            The interactive reference didn&apos;t load (it needs JavaScript and our documentation
            CDN). The full machine-readable spec is at{" "}
            <a href="/api/v1/openapi.json" className="text-ink underline underline-offset-2">
              /api/v1/openapi.json
            </a>
            .
          </p>
        </elements-api>
      </main>
    </>
  );
}
