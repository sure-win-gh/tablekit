// Opinionated venue templates. Applied on venue creation to hit the
// "15-minute activation" target in the spec — a new operator lands on
// a floor plan they can already book against, rather than an empty
// canvas.
//
// Pure data, intentionally no logic here. Keyed by `venue_type`; the
// createVenue server action runs one transaction that inserts one
// venue row and every area / table / service below.

export type VenueType = "cafe" | "restaurant" | "bar_pub";

export type TemplatePosition = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type TemplateTable = {
  label: string;
  minCover: number;
  maxCover: number;
  position: TemplatePosition;
};

export type TemplateArea = {
  name: string;
  tables: TemplateTable[];
};

export type TemplateService = {
  name: string;
  schedule: {
    days: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
    start: string; // "HH:MM"
    end: string; // "HH:MM"
  };
  turnMinutes: number;
};

export type VenueTemplate = {
  areas: TemplateArea[];
  services: TemplateService[];
};

const EVERY_DAY = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export const templates: Record<VenueType, VenueTemplate> = {
  cafe: {
    areas: [
      {
        name: "Inside",
        tables: Array.from({ length: 6 }, (_, i) => ({
          label: `T${i + 1}`,
          minCover: 2,
          maxCover: 4,
          position: {
            x: (i % 3) * 3,
            y: Math.floor(i / 3) * 3,
            w: 2,
            h: 2,
          },
        })),
      },
    ],
    services: [
      {
        name: "Open",
        schedule: { days: [...EVERY_DAY], start: "08:00", end: "17:00" },
        turnMinutes: 45,
      },
    ],
  },

  restaurant: {
    areas: [
      {
        name: "Main",
        tables: [
          { label: "1", minCover: 2, maxCover: 4, position: { x: 0, y: 0, w: 2, h: 2 } },
          { label: "2", minCover: 2, maxCover: 4, position: { x: 3, y: 0, w: 2, h: 2 } },
          { label: "3", minCover: 2, maxCover: 4, position: { x: 6, y: 0, w: 2, h: 2 } },
          { label: "4", minCover: 4, maxCover: 6, position: { x: 0, y: 3, w: 3, h: 2 } },
          { label: "5", minCover: 4, maxCover: 6, position: { x: 4, y: 3, w: 3, h: 2 } },
        ],
      },
      {
        name: "Bar",
        tables: [
          { label: "B1", minCover: 1, maxCover: 2, position: { x: 0, y: 0, w: 1, h: 1 } },
          { label: "B2", minCover: 1, maxCover: 2, position: { x: 2, y: 0, w: 1, h: 1 } },
          { label: "B3", minCover: 1, maxCover: 2, position: { x: 4, y: 0, w: 1, h: 1 } },
        ],
      },
    ],
    services: [
      {
        name: "Lunch",
        schedule: { days: [...EVERY_DAY], start: "12:00", end: "15:00" },
        turnMinutes: 90,
      },
      {
        name: "Dinner",
        schedule: { days: [...EVERY_DAY], start: "18:00", end: "22:00" },
        turnMinutes: 90,
      },
    ],
  },

  bar_pub: {
    areas: [
      {
        name: "Inside",
        tables: [
          { label: "1", minCover: 2, maxCover: 4, position: { x: 0, y: 0, w: 2, h: 2 } },
          { label: "2", minCover: 2, maxCover: 4, position: { x: 3, y: 0, w: 2, h: 2 } },
          { label: "3", minCover: 2, maxCover: 6, position: { x: 0, y: 3, w: 3, h: 2 } },
        ],
      },
      {
        name: "Outside",
        tables: [
          { label: "O1", minCover: 2, maxCover: 4, position: { x: 0, y: 0, w: 2, h: 2 } },
          { label: "O2", minCover: 2, maxCover: 4, position: { x: 3, y: 0, w: 2, h: 2 } },
        ],
      },
    ],
    services: [
      {
        name: "Open",
        schedule: { days: [...EVERY_DAY], start: "12:00", end: "23:00" },
        turnMinutes: 60,
      },
    ],
  },
};
