// Unit tests for lib/google/places.ts. fetch is mocked — these don't
// hit the real Places API. We assert the wire contract (URL, method,
// field mask, headers, body) plus response shaping (wire snake-case
// → our PlaceDetails ergonomic shape).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalKey = process.env["GOOGLE_PLACES_API_KEY"];

beforeEach(() => {
  process.env["GOOGLE_PLACES_API_KEY"] = "test-places-key";
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalKey === undefined) delete process.env["GOOGLE_PLACES_API_KEY"];
  else process.env["GOOGLE_PLACES_API_KEY"] = originalKey;
});

describe("isConfigured", () => {
  it("false when env var unset or empty", async () => {
    delete process.env["GOOGLE_PLACES_API_KEY"];
    const { isConfigured } = await import("@/lib/google/places");
    expect(isConfigured()).toBe(false);

    process.env["GOOGLE_PLACES_API_KEY"] = "  ";
    vi.resetModules();
    const { isConfigured: again } = await import("@/lib/google/places");
    expect(again()).toBe(false);
  });

  it("true when set", async () => {
    const { isConfigured } = await import("@/lib/google/places");
    expect(isConfigured()).toBe(true);
  });
});

describe("searchPlaces", () => {
  it("returns places on a 200 with the right wire contract", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          places: [
            {
              id: "ChIJpadella",
              displayName: { text: "Padella Borough" },
              formattedAddress: "6 Southwark St, London SE1 1TQ",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const { searchPlaces } = await import("@/lib/google/places");
    const r = await searchPlaces("padella");

    expect(r).toEqual({
      ok: true,
      places: [
        {
          id: "ChIJpadella",
          displayName: "Padella Borough",
          formattedAddress: "6 Southwark St, London SE1 1TQ",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("test-places-key");
    expect(headers["X-Goog-FieldMask"]).toBe(
      "places.id,places.displayName,places.formattedAddress",
    );
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({
      textQuery: "padella",
      regionCode: "GB",
    });
  });

  it("short-circuits to {ok:false,status:'not-configured'} when key missing", async () => {
    delete process.env["GOOGLE_PLACES_API_KEY"];
    const fetchMock = vi.spyOn(global, "fetch");

    const { searchPlaces } = await import("@/lib/google/places");
    const r = await searchPlaces("anything");

    expect(r).toEqual({ ok: false, status: "not-configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty array for an empty query without calling Google", async () => {
    const fetchMock = vi.spyOn(global, "fetch");
    const { searchPlaces } = await import("@/lib/google/places");
    const r = await searchPlaces("   ");
    expect(r).toEqual({ ok: true, places: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces non-2xx with the wire status + body", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("API key invalid", { status: 403 }));
    const { searchPlaces } = await import("@/lib/google/places");
    const r = await searchPlaces("padella");
    expect(r).toEqual({ ok: false, status: 403, error: "API key invalid" });
  });

  it("parses Google's JSON error envelope down to just the message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const { searchPlaces } = await import("@/lib/google/places");
    const r = await searchPlaces("padella");
    expect(r).toEqual({ ok: false, status: 400, error: "API key not valid." });
  });

  it("drops malformed entries (missing id/name/address)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          places: [
            { id: "good", displayName: { text: "Good" }, formattedAddress: "Addr" },
            { id: "bad" }, // missing name + address
            { displayName: { text: "Nameless" }, formattedAddress: "Addr" }, // missing id
          ],
        }),
        { status: 200 },
      ),
    );
    const { searchPlaces } = await import("@/lib/google/places");
    const r = await searchPlaces("x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.places).toHaveLength(1);
    expect(r.places[0]!.id).toBe("good");
  });
});

describe("getPlaceDetails", () => {
  it("shapes the wire response into our PlaceDetails type", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "ChIJpadella",
          displayName: { text: "Padella Borough" },
          formattedAddress: "6 Southwark St, London SE1 1TQ",
          internationalPhoneNumber: "+44 20 7407 0000",
          websiteUri: "https://padella.co",
          regularOpeningHours: {
            periods: [
              {
                open: { day: 1, hour: 12, minute: 0 },
                close: { day: 1, hour: 14, minute: 30 },
              },
              {
                open: { day: 1, hour: 17, minute: 30 },
                close: { day: 1, hour: 22, minute: 0 },
              },
            ],
          },
          types: ["restaurant", "food", "point_of_interest"],
          location: { latitude: 51.5055, longitude: -0.0908 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const { getPlaceDetails } = await import("@/lib/google/places");
    const r = await getPlaceDetails("ChIJpadella");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.place).toEqual({
      id: "ChIJpadella",
      displayName: "Padella Borough",
      formattedAddress: "6 Southwark St, London SE1 1TQ",
      internationalPhoneNumber: "+44 20 7407 0000",
      websiteUri: "https://padella.co",
      regularOpeningPeriods: [
        { open: { day: 1, hour: 12, minute: 0 }, close: { day: 1, hour: 14, minute: 30 } },
        { open: { day: 1, hour: 17, minute: 30 }, close: { day: 1, hour: 22, minute: 0 } },
      ],
      types: ["restaurant", "food", "point_of_interest"],
      location: { lat: 51.5055, lng: -0.0908 },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://places.googleapis.com/v1/places/ChIJpadella");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("test-places-key");
    expect(headers["X-Goog-FieldMask"]).toContain("regularOpeningHours");
    expect(headers["X-Goog-FieldMask"]).toContain("location");
  });

  it("flags malformed 2xx responses with the dedicated status discriminant", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "x" }), { status: 200 }),
    );
    const { getPlaceDetails } = await import("@/lib/google/places");
    const r = await getPlaceDetails("x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe("malformed-response");
  });

  it("URL-encodes the place id", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "weird id",
          displayName: { text: "X" },
          formattedAddress: "Y",
        }),
        { status: 200 },
      ),
    );
    const { getPlaceDetails } = await import("@/lib/google/places");
    await getPlaceDetails("weird id");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://places.googleapis.com/v1/places/weird%20id");
  });
});
