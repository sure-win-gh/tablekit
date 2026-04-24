// Public booking API.
//
// POST /api/v1/bookings — anonymous. Rate-limited + captcha-verified
// at the boundary, then delegates to the same `createBooking` domain
// function the host flow uses. `source: "widget"` differentiates the
// two in reporting.
//
// Intentionally narrow: no org context header, no auth. The venueId
// in the body is the only input that matters; everything else is
// derived from the DB. If a caller tries to forge an organisation,
// the availability + exclusion layers still reject.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { createBooking } from "@/lib/bookings/create";
import { upsertGuestInput } from "@/lib/guests/schema";
import { bookingReference, verifyCaptcha } from "@/lib/public/captcha";
import { ipFromHeaders, rateLimit } from "@/lib/public/rate-limit";
import { resolveVenueOrg } from "@/lib/public/venue";

const Body = z.object({
  venueId: z.string().uuid(),
  serviceId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  wallStart: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  partySize: z.number().int().min(1).max(20),
  notes: z.string().max(500).optional(),
  captchaToken: z.string().optional(),
  guest: upsertGuestInput,
});

export async function POST(req: NextRequest) {
  // 1. Rate limit by IP before we do any DB work.
  const ip = ipFromHeaders(req.headers);
  const rl = await rateLimit(`bookings:${ip}`, 5, 10 * 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec ?? 600) } },
    );
  }

  // 2. Parse + validate.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid-input",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      { status: 400 },
    );
  }

  // 3. Captcha. Pass-through if no secret configured.
  const captcha = await verifyCaptcha(parsed.data.captchaToken, ip);
  if (!captcha.ok) {
    return NextResponse.json({ error: "captcha-failed", reason: captcha.reason }, { status: 400 });
  }

  // 4. Resolve the org the venue belongs to. 404 if the venue is
  //    unknown — don't leak organisation structure by returning 403.
  const organisationId = await resolveVenueOrg(parsed.data.venueId);
  if (!organisationId) {
    return NextResponse.json({ error: "venue-not-found" }, { status: 404 });
  }

  // 5. Hand off to the same domain function the host flow uses.
  const r = await createBooking(organisationId, null, {
    venueId: parsed.data.venueId,
    serviceId: parsed.data.serviceId,
    date: parsed.data.date,
    wallStart: parsed.data.wallStart,
    partySize: parsed.data.partySize,
    guest: parsed.data.guest,
    source: "widget",
    ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
  });

  if (!r.ok) {
    const status = {
      "guest-invalid": 400,
      "slot-taken": 409,
      "no-availability": 409,
      "venue-not-found": 404,
    }[r.reason];
    return NextResponse.json({ error: r.reason, ...("issues" in r ? { issues: r.issues } : {}) }, { status });
  }

  return NextResponse.json(
    { ok: true, bookingId: r.bookingId, reference: bookingReference(r.bookingId) },
    { status: 201 },
  );
}
