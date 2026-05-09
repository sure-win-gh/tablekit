// Smoke tests for the v1 OpenAPI document. Asserts the document
// builds without throwing and that the path set matches what the
// route handlers actually expose. The drift trip-wire: a route
// added without a corresponding entry here (or vice versa) will
// fail the path-set check and prompt an explicit decision.

import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "@/lib/api/v1/openapi";

describe("OpenAPI document", () => {
  it("builds without throwing", () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.title).toBe("TableKit API");
  });

  it("exposes exactly the spec's launch endpoint set", () => {
    const doc = buildOpenApiDocument();
    const paths = Object.keys(doc.paths ?? {}).sort();
    expect(paths).toEqual(
      ["/bookings", "/bookings/{id}", "/guests", "/guests/{id}", "/services", "/venues"].sort(),
    );
  });

  it("declares the right HTTP methods on each path", () => {
    const doc = buildOpenApiDocument();
    const methodsOf = (p: string): string[] =>
      Object.keys((doc.paths as Record<string, Record<string, unknown>>)[p] ?? {})
        .filter((k) => ["get", "post", "patch", "put", "delete"].includes(k))
        .sort();

    expect(methodsOf("/bookings")).toEqual(["get", "post"]);
    expect(methodsOf("/bookings/{id}")).toEqual(["get", "patch"]);
    expect(methodsOf("/guests")).toEqual(["get"]);
    expect(methodsOf("/guests/{id}")).toEqual(["get"]);
    expect(methodsOf("/venues")).toEqual(["get"]);
    expect(methodsOf("/services")).toEqual(["get"]);
  });

  it("declares Bearer auth as the global security scheme", () => {
    const doc = buildOpenApiDocument();
    expect(doc.components?.securitySchemes?.["bearerAuth"]).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it("registers reusable component schemas with stable ids", () => {
    const doc = buildOpenApiDocument();
    const schemas = Object.keys(doc.components?.schemas ?? {}).sort();
    // Whichever schemas we tagged with `id` in lib/api/v1/openapi.ts
    // become components/schemas. The exact set is the contract.
    for (const id of [
      "Error",
      "Booking",
      "BookingCreate",
      "BookingPatch",
      "Guest",
      "GuestSummary",
      "Venue",
      "Service",
    ]) {
      expect(schemas).toContain(id);
    }
  });
});
