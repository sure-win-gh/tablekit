// Coarse visitor-location detection from edge geo headers, used for
// light touches like the "Made in Wales / Great Britain" footer note.
//
// Traffic reaches Vercel through Cloudflare, so we read whichever set of
// geo headers is present:
//   - Cloudflare: `cf-ipcountry`, `cf-region-code` (the latter only when the
//     "Add visitor location headers" managed transform is enabled).
//   - Vercel:     `x-vercel-ip-country`, `x-vercel-ip-country-region`.
//
// Both emit ISO 3166-1 alpha-2 country codes and ISO 3166-2 subdivision
// codes (without the `GB-` prefix). This is best-effort only — geo-IP is
// approximate and headers can be absent (local dev, CI, privacy proxies),
// in which case we return `null` and the caller shows nothing.

export type UkRegion = "wales" | "great-britain";

// ISO 3166-2:GB subdivision codes that sit within Wales: the top-level
// country code plus all 22 principal areas. Geo-IP providers vary in how
// granular a subdivision they return, so we match against the full set.
const WELSH_SUBDIVISIONS = new Set([
  "WLS", // Wales (country-level subdivision)
  "AGY", // Isle of Anglesey
  "BGE", // Bridgend
  "BGW", // Blaenau Gwent
  "CAY", // Caerphilly
  "CGN", // Ceredigion
  "CMN", // Carmarthenshire
  "CRF", // Cardiff
  "CWY", // Conwy
  "DEN", // Denbighshire
  "FLN", // Flintshire
  "GWN", // Gwynedd
  "MON", // Monmouthshire
  "MTY", // Merthyr Tydfil
  "NTL", // Neath Port Talbot
  "NWP", // Newport
  "PEM", // Pembrokeshire
  "POW", // Powys
  "RCT", // Rhondda Cynon Taf
  "SWA", // Swansea
  "TOF", // Torfaen
  "VGL", // Vale of Glamorgan
  "WRX", // Wrexham
]);

// UK country codes. GB covers England, Scotland, Wales and Northern Ireland;
// the Crown Dependencies (Jersey, Guernsey, Isle of Man) have their own codes
// and are treated as "Great Britain" for this purposely-loose label.
const UK_COUNTRIES = new Set(["GB", "JE", "GG", "IM"]);

function firstHeader(headers: Headers, ...names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value.trim().toUpperCase();
  }
  return null;
}

/**
 * Returns "wales" for visitors geolocated to Wales, "great-britain" for the
 * rest of the UK, or null when the visitor is outside the UK or location is
 * unknown.
 */
export function visitorUkRegion(headers: Headers): UkRegion | null {
  const country = firstHeader(headers, "cf-ipcountry", "x-vercel-ip-country");
  if (!country || !UK_COUNTRIES.has(country)) return null;

  const region = firstHeader(headers, "cf-region-code", "x-vercel-ip-country-region");
  if (region && WELSH_SUBDIVISIONS.has(region)) return "wales";

  return "great-britain";
}
