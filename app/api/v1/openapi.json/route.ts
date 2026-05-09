// GET /api/v1/openapi.json — public OpenAPI 3.1 document for the
// TableKit REST API. No auth required (industry convention; SDK
// generators fetch this anonymously). Document built from Zod
// definitions in lib/api/v1/openapi.ts.

import { NextResponse } from "next/server";

import { buildOpenApiDocument } from "@/lib/api/v1/openapi";

export const dynamic = "force-static";
export const runtime = "nodejs";

export function GET() {
  const doc = buildOpenApiDocument();
  return NextResponse.json(doc, {
    headers: {
      // Cache for 1h at the edge — the doc only changes on deploy.
      "cache-control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
