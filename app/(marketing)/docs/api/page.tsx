import type { Metadata } from "next";

import { ApiDocsViewer } from "./viewer";

export const metadata: Metadata = {
  title: "API reference · TableKit",
  description: "REST API documentation for the TableKit Plus tier.",
};

// Public, unauthenticated. Renders the Stoplight Elements web
// component over our /api/v1/openapi.json document. SDK generators
// (orval, openapi-generator, …) keep using the raw JSON; this page
// is for human browsing + try-it.
//
// The viewer is split into a "use client" component because
// Stoplight Elements is a web-component bundle that registers
// custom elements on the window — it has to load on the client.

export default function ApiDocsPage() {
  return <ApiDocsViewer />;
}
