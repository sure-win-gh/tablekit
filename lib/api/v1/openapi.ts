// OpenAPI 3.1 document for the public REST API at /api/v1/*.
//
// Schemas use Zod 4's native `.meta()` to attach OpenAPI metadata.
// `zod-openapi` v5 reads that metadata when building the document —
// no monkey-patching or `.openapi()` extension required.
//
// Drift mitigation: a smoke test asserts the generated document's
// shape (path count + a few well-known fields). When you change a
// route's request/response shape, update this file too. Each route
// header points readers here.
//
// Served at GET /api/v1/openapi.json (public — no auth, cached 1h).

import "server-only";

import { z } from "zod";
import { createDocument } from "zod-openapi";

// -----------------------------------------------------------------------------
// Shared schemas
// -----------------------------------------------------------------------------

const Iso8601 = z.string().meta({ format: "date-time", example: "2026-06-15T19:00:00.000Z" });
const Uuid = z
  .string()
  .uuid()
  .meta({ format: "uuid", example: "00000000-0000-0000-0000-000000000000" });

const ErrorBody = z
  .object({
    error: z.object({
      code: z.enum([
        "unauthorized",
        "not_found",
        "bad_request",
        "conflict",
        "rate_limited",
        "internal_error",
      ]),
      message: z.string(),
    }),
  })
  .meta({
    id: "Error",
    description: "Stable error envelope. Branch on `error.code`, never on message.",
  });

const Cursor = z
  .string()
  .meta({ description: "Opaque pagination token from a previous response's next_cursor." });

const Limit = z
  .number()
  .int()
  .min(1)
  .max(100)
  .meta({ description: "Page size. Default 20, max 100." });

// -----------------------------------------------------------------------------
// Resource schemas
// -----------------------------------------------------------------------------

const Booking = z
  .object({
    id: Uuid,
    venue_id: Uuid,
    service_id: Uuid,
    guest_id: Uuid,
    party_size: z.number().int().min(1),
    start_at: Iso8601,
    end_at: Iso8601,
    status: z.enum(["requested", "confirmed", "seated", "finished", "cancelled", "no_show"]),
    source: z.enum(["host", "widget", "rwg", "api"]),
    notes: z.string().nullable(),
    cancelled_at: Iso8601.nullable(),
    created_at: Iso8601,
    updated_at: Iso8601,
  })
  .meta({ id: "Booking" });

const BookingCreateBody = z
  .object({
    venueId: Uuid,
    serviceId: Uuid,
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .meta({ example: "2026-06-15", description: "Venue-local date (YYYY-MM-DD)." }),
    wallStart: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/)
      .meta({ example: "19:00", description: "Venue-local 24h start time (HH:MM)." }),
    partySize: z.number().int().min(1).max(20),
    notes: z.string().max(500).optional(),
    guest: z.object({
      firstName: z.string().min(1).max(80),
      lastName: z.string().max(80).optional(),
      email: z.string().email().max(200),
      phone: z.string().max(40).optional(),
    }),
  })
  .meta({ id: "BookingCreate" });

const BookingPatchBody = z
  .object({
    status: z.literal("cancelled").optional(),
    cancelled_reason: z.string().min(1).max(500).optional(),
    start_at: Iso8601.optional(),
  })
  .meta({
    id: "BookingPatch",
    description:
      'Specify exactly one of `status: "cancelled"` or `start_at`. `cancelled_reason` is only valid with the cancel form.',
  });

const Guest = z
  .object({
    id: Uuid,
    first_name: z.string(),
    last_name: z.string(),
    email: z.string().email(),
    email_hash: z
      .string()
      .meta({ description: "HMAC of normalised email; safe to store + compare." }),
    phone: z.string().nullable(),
    email_invalid: z.boolean(),
    phone_invalid: z.boolean(),
    marketing_consent_email_at: Iso8601.nullable(),
    marketing_consent_sms_at: Iso8601.nullable(),
    email_unsubscribed_venues: z.array(Uuid),
    sms_unsubscribed_venues: z.array(Uuid),
    created_at: Iso8601,
  })
  .meta({ id: "Guest" });

const GuestSummary = z
  .object({
    id: Uuid,
    first_name: z.string(),
    email_hash: z.string(),
    created_at: Iso8601,
  })
  .meta({
    id: "GuestSummary",
    description: "Minimal projection used by GET /v1/guests. Fetch /v1/guests/:id for full PII.",
  });

const Venue = z
  .object({
    id: Uuid,
    name: z.string(),
    slug: z.string().nullable(),
    venue_type: z.string(),
    timezone: z.string(),
    locale: z.string(),
    created_at: Iso8601,
  })
  .meta({ id: "Venue" });

const Service = z
  .object({
    id: Uuid,
    venue_id: Uuid,
    name: z.string(),
    schedule: z
      .unknown()
      .meta({ description: "Operator-defined schedule object: { days, start, end }." }),
    turn_minutes: z.number().int(),
    created_at: Iso8601,
  })
  .meta({ id: "Service" });

// -----------------------------------------------------------------------------
// Document
// -----------------------------------------------------------------------------

export function buildOpenApiDocument() {
  return createDocument({
    openapi: "3.1.0",
    info: {
      title: "TableKit API",
      version: "1.0.0",
      description: [
        "REST API for Plus-tier customers. Bearer auth via API keys issued from /dashboard/organisation/api-keys (account owner only).",
        "",
        "**Rate limits:** 600 requests/minute per key. Exceeding it returns 429 with a `Retry-After` header (seconds). Request bodies over 32 KB are rejected.",
        "",
        "**Webhooks:** subscribe at /dashboard/organisation/webhooks to receive booking.created / updated / cancelled / seated / no_show events, signed with `X-TableKit-Signature: sha256=<hmac>` over the raw body. Verification guide: https://tablekit.uk/docs/webhooks",
        "",
        "Guides in plain English: https://tablekit.uk/docs",
      ].join("\n"),
    },
    servers: [{ url: "https://api.tablekit.uk/v1" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API key (sk_live_...)",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/bookings": {
        get: {
          summary: "List bookings",
          parameters: [
            Uuid.optional().meta({ param: { name: "venue_id", in: "query" } }),
            Iso8601.optional().meta({ param: { name: "from", in: "query" } }),
            Iso8601.optional().meta({ param: { name: "to", in: "query" } }),
            z
              .string()
              .optional()
              .meta({
                param: { name: "status", in: "query" },
                description:
                  "Comma-separated subset of: requested,confirmed,seated,finished,cancelled,no_show",
              }),
            Cursor.optional().meta({ param: { name: "cursor", in: "query" } }),
            Limit.optional().meta({ param: { name: "limit", in: "query" } }),
          ],
          responses: {
            "200": {
              description: "Paginated booking list.",
              content: {
                "application/json": {
                  schema: z.object({
                    data: z.array(Booking),
                    next_cursor: z.string().nullable(),
                  }),
                },
              },
            },
            "401": errorRef(),
            "429": errorRef(),
          },
        },
        post: {
          summary: "Create a booking",
          parameters: [idempotencyHeader()],
          requestBody: {
            required: true,
            content: { "application/json": { schema: BookingCreateBody } },
          },
          responses: {
            "201": {
              description: "Booking created.",
              content: {
                "application/json": {
                  schema: z.object({
                    data: z.object({
                      id: Uuid,
                      reference: z.string().meta({ example: "1A2B-3C4D" }),
                      status: z.enum(["confirmed", "requested"]),
                    }),
                  }),
                },
              },
            },
            "400": errorRef(),
            "401": errorRef(),
            "404": errorRef(),
            "409": errorRef(),
            "429": errorRef(),
          },
        },
      },
      "/bookings/{id}": {
        get: {
          summary: "Fetch a booking",
          parameters: [Uuid.meta({ param: { name: "id", in: "path" } })],
          responses: {
            "200": {
              description: "Booking detail.",
              content: { "application/json": { schema: z.object({ data: Booking }) } },
            },
            "401": errorRef(),
            "404": errorRef(),
            "429": errorRef(),
          },
        },
        patch: {
          summary: "Cancel or reschedule a booking",
          parameters: [Uuid.meta({ param: { name: "id", in: "path" } }), idempotencyHeader()],
          requestBody: {
            required: true,
            content: { "application/json": { schema: BookingPatchBody } },
          },
          responses: {
            "200": {
              description: "Updated.",
              content: { "application/json": { schema: z.unknown() } },
            },
            "400": errorRef(),
            "401": errorRef(),
            "404": errorRef(),
            "409": errorRef(),
            "429": errorRef(),
          },
        },
      },
      "/guests": {
        get: {
          summary: "List guests (minimal projection)",
          parameters: [
            Cursor.optional().meta({ param: { name: "cursor", in: "query" } }),
            Limit.optional().meta({ param: { name: "limit", in: "query" } }),
          ],
          responses: {
            "200": {
              description: "Paginated guest list.",
              content: {
                "application/json": {
                  schema: z.object({
                    data: z.array(GuestSummary),
                    next_cursor: z.string().nullable(),
                  }),
                },
              },
            },
            "401": errorRef(),
            "429": errorRef(),
          },
        },
      },
      "/guests/{id}": {
        get: {
          summary: "Fetch a guest (full PII)",
          parameters: [Uuid.meta({ param: { name: "id", in: "path" } })],
          responses: {
            "200": {
              description: "Guest detail.",
              content: { "application/json": { schema: z.object({ data: Guest }) } },
            },
            "401": errorRef(),
            "404": errorRef(),
            "429": errorRef(),
          },
        },
      },
      "/venues": {
        get: {
          summary: "List venues (alphabetical, capped at 200)",
          responses: {
            "200": {
              description: "Venue list.",
              content: { "application/json": { schema: z.object({ data: z.array(Venue) }) } },
            },
            "401": errorRef(),
            "429": errorRef(),
          },
        },
      },
      "/services": {
        get: {
          summary: "List services (optionally filtered by venue)",
          parameters: [Uuid.optional().meta({ param: { name: "venue_id", in: "query" } })],
          responses: {
            "200": {
              description: "Service list.",
              content: { "application/json": { schema: z.object({ data: z.array(Service) }) } },
            },
            "401": errorRef(),
            "429": errorRef(),
          },
        },
      },
      "/availability": {
        get: {
          summary: "List bookable slots for a venue on a date",
          description:
            "Public, anonymous (no Bearer auth required). IP rate-limited (30/min). Returns the slots the booking POST will accept on that date for the given party size. Times are venue-local in `wall_start` and UTC ISO-8601 in `start_at`/`end_at`.",
          security: [],
          parameters: [
            Uuid.meta({ param: { name: "venue_id", in: "query" } }),
            z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .meta({
                param: { name: "date", in: "query" },
                example: "2026-06-15",
                description: "Venue-local date (YYYY-MM-DD).",
              }),
            z
              .number()
              .int()
              .min(1)
              .max(20)
              .meta({ param: { name: "party_size", in: "query" } }),
          ],
          responses: {
            "200": {
              description: "Slots for the requested date + party size.",
              content: {
                "application/json": {
                  schema: z.object({
                    venue_id: Uuid,
                    timezone: z.string(),
                    date: z.string(),
                    party_size: z.number().int(),
                    slots: z.array(
                      z.object({
                        service_id: Uuid,
                        service_name: z.string(),
                        wall_start: z.string().meta({ example: "19:00" }),
                        start_at: Iso8601,
                        end_at: Iso8601,
                      }),
                    ),
                  }),
                },
              },
            },
            "400": errorRef(),
            "404": errorRef(),
            "429": errorRef(),
          },
        },
      },
    },
  });
}

function errorRef() {
  return {
    description: "Error response.",
    content: { "application/json": { schema: ErrorBody } },
  };
}

function idempotencyHeader() {
  return z
    .string()
    .min(1)
    .max(200)
    .optional()
    .meta({
      param: { name: "Idempotency-Key", in: "header" },
      description:
        "Optional. Replays return the original response without re-running the side effect. Bucketed per API key.",
    });
}
