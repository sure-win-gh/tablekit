// Pure FormData → schema mapping for the signup action, extracted so the
// wiring is unit-testable in isolation. A field silently dropped here is a
// real defect — `country` in particular becomes the org's data region +
// billing entity, so losing it is a data-residency bug (it once was: the
// field existed in the schema but was never read from FormData). Tested in
// tests/unit/signup-parse.test.ts.

import { z } from "zod";

export const SignupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(128),
  fullName: z.string().min(1).max(120),
  orgName: z.string().min(1).max(120),
  // ISO 3166-1 alpha-2 from the country picker (D1). `.nullish()` (not
  // `.optional()`) on purpose: `formData.get("country")` returns null when
  // the field is absent — a no-JS post — and z rejects null under optional,
  // which would fail the WHOLE signup. Loose because regionForCountry is
  // total: an absent/unknown value safely resolves to EU/UK (D2); the action
  // defaults null/undefined to GB. The country string itself is not
  // persisted — only the derived region + billing_entity are.
  country: z.string().max(8).nullish(),
});

export type SignupInput = z.infer<typeof SignupSchema>;

export type SignupParse =
  | { ok: true; data: SignupInput }
  | { ok: false; fieldErrors: Record<string, string[]> };

/**
 * Map the signup FormData onto SignupSchema. Every field the form posts is
 * read here — keep this the single place that reads `formData` so a new
 * field can't be added to the form and forgotten on the server.
 */
export function parseSignupForm(formData: FormData): SignupParse {
  const parsed = SignupSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    fullName: formData.get("full_name"),
    orgName: formData.get("org_name"),
    country: formData.get("country"),
  });
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors };
  }
  return { ok: true, data: parsed.data };
}
