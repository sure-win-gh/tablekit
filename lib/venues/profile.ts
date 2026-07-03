// Typed parser for the `profile` slice of venues.settings — the public
// venue-info shown on the rich (Core+) booking page: description, cuisine,
// price range, address, contact, and geo (stored for the Phase-4 map, not
// rendered yet). See docs/specs/booking-page.md.
//
// Mirrors parseBranding in lib/messaging/venue-settings.ts: lenient by
// design — a malformed field drops out rather than failing the whole slice,
// so a bad stored value never blanks an operator's whole profile. No
// "server-only": pure, so the dashboard form + tests can reuse the schema.

import { z } from "zod";

export type VenuePriceRange = "£" | "££" | "£££" | "££££";

export type VenueAddress = {
  street?: string | null;
  city?: string | null;
  postcode?: string | null;
};

export type VenueProfile = {
  description?: string | null;
  cuisine?: string | null;
  priceRange?: VenuePriceRange | null;
  address?: VenueAddress | null;
  phone?: string | null;
  website?: string | null; // https only
  // Link-out to the venue's menu (their own site / PDF). We deliberately
  // don't model menu content — one URL, zero schema.
  menuUrl?: string | null; // https only
  latitude?: number | null; // used for the "Get directions" map link
  longitude?: number | null;
  // Manual TripAdvisor badge — their Content API excludes B2B SaaS, so the
  // operator types their own rating + page URL; we render a badge linking out.
  tripadvisorRating?: number | null; // 0–5
  tripadvisorUrl?: string | null; // https only
};

const PRICE_RANGES = ["£", "££", "£££", "££££"] as const;

const isHttps = (v: string) => v.startsWith("https://");

const addressSchema = z.object({
  street: z.string().max(160).nullish(),
  city: z.string().max(80).nullish(),
  postcode: z.string().max(12).nullish(),
});

const profileSchema = z.object({
  description: z.string().max(2000).nullish(),
  cuisine: z.string().max(80).nullish(),
  priceRange: z.enum(PRICE_RANGES).nullish(),
  address: addressSchema.nullish(),
  phone: z.string().max(32).nullish(),
  website: z.string().url().max(2048).refine(isHttps).nullish(),
  menuUrl: z.string().url().max(2048).refine(isHttps).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  tripadvisorRating: z.number().min(0).max(5).nullish(),
  tripadvisorUrl: z.string().url().max(2048).refine(isHttps).nullish(),
});

function cleanAddress(raw: unknown): VenueAddress | undefined {
  const parsed = addressSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const a: VenueAddress = {};
  if (parsed.data.street) a.street = parsed.data.street;
  if (parsed.data.city) a.city = parsed.data.city;
  if (parsed.data.postcode) a.postcode = parsed.data.postcode;
  return Object.keys(a).length > 0 ? a : undefined;
}

// Read venues.settings.profile into a typed object, or undefined when
// absent/empty so the page falls back to name-only. Salvages valid fields
// individually when the whole slice doesn't parse.
export function parseProfile(settings: unknown): VenueProfile | undefined {
  const root =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>)["profile"]
      : undefined;
  if (!root || typeof root !== "object") return undefined;

  const parsed = profileSchema.safeParse(root);
  const data = parsed.success ? parsed.data : null;
  const raw = root as Record<string, unknown>;

  const out: VenueProfile = {};
  const str = (k: string, max: number) => {
    const v = data ? (data as Record<string, unknown>)[k] : raw[k];
    if (typeof v === "string" && v.length > 0) return v.slice(0, max);
    return undefined;
  };

  const description = str("description", 2000);
  if (description) out.description = description;
  const cuisine = str("cuisine", 80);
  if (cuisine) out.cuisine = cuisine;
  if (typeof raw["priceRange"] === "string" && PRICE_RANGES.includes(raw["priceRange"] as never)) {
    out.priceRange = raw["priceRange"] as VenuePriceRange;
  }
  const address = cleanAddress(raw["address"]);
  if (address) out.address = address;
  const phone = str("phone", 32);
  if (phone) out.phone = phone;
  if (typeof raw["website"] === "string" && isHttps(raw["website"])) {
    const w = z.string().url().max(2048).safeParse(raw["website"]);
    if (w.success) out.website = w.data;
  }
  if (typeof raw["menuUrl"] === "string" && isHttps(raw["menuUrl"])) {
    const m = z.string().url().max(2048).safeParse(raw["menuUrl"]);
    if (m.success) out.menuUrl = m.data;
  }
  if (typeof raw["latitude"] === "number" && raw["latitude"] >= -90 && raw["latitude"] <= 90) {
    out.latitude = raw["latitude"];
  }
  if (typeof raw["longitude"] === "number" && raw["longitude"] >= -180 && raw["longitude"] <= 180) {
    out.longitude = raw["longitude"];
  }
  if (
    typeof raw["tripadvisorRating"] === "number" &&
    raw["tripadvisorRating"] >= 0 &&
    raw["tripadvisorRating"] <= 5
  ) {
    out.tripadvisorRating = raw["tripadvisorRating"];
  }
  if (typeof raw["tripadvisorUrl"] === "string" && isHttps(raw["tripadvisorUrl"])) {
    const u = z.string().url().max(2048).safeParse(raw["tripadvisorUrl"]);
    if (u.success) out.tripadvisorUrl = u.data;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
