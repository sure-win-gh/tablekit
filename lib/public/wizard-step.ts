// Pure step logic for the conversational booking wizard (Party → Date → Time
// → Details). The current step is derived from which search params are
// present — there is no explicit ?step, so the URL can never desync from the
// rendered step. Shared by the client step components (forward nav) and the
// server orchestrator + summary trail (edit links) so both build identical
// URLs. See docs/specs/booking-page.md / the wizard plan.

export type WizardStep = "party" | "date" | "time" | "details";

export type WizardParams = {
  party?: number | undefined;
  date?: string | undefined; // YYYY-MM-DD
  month?: string | undefined; // YYYY-MM (date-step calendar browsing only)
  serviceId?: string | undefined;
  wallStart?: string | undefined; // HH:MM
  // Marketing campaign attribution (?tk_c=<campaignId>, appended to
  // booking links in campaign emails). Carried through every step by the
  // shared URL contract — no cookies/storage — and stamped on the created
  // booking (server re-validates org/venue). marketing-suite.md Phase B.
  campaign?: string | undefined;
};

export type RawSearchParams = {
  party?: string;
  date?: string;
  month?: string;
  serviceId?: string;
  wallStart?: string;
  tk_c?: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validCampaign(raw: string | undefined): string | undefined {
  return raw && UUID_RE.test(raw) ? raw.toLowerCase() : undefined;
}

export function validParty(raw: string | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : undefined;
}

export function validDate(raw: string | undefined): string | undefined {
  return raw && DATE_RE.test(raw) ? raw : undefined;
}

export function validMonth(raw: string | undefined): string | undefined {
  return raw && MONTH_RE.test(raw) ? raw : undefined;
}

// How far ahead a guest may browse the calendar — bounds the public,
// unauthenticated month-availability load so a crafted ?month= can't walk
// arbitrarily far forward and amplify DB work.
export const MAX_MONTHS_AHEAD = 12;

// "YYYY-MM" month arithmetic. App/SSR + client code (no workflow-script Date ban).
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// month / min / max are "YYYY-MM"; lexicographic compare == chronological.
export function floorMonth(month: string, minMonth: string): string {
  return month < minMonth ? minMonth : month;
}

export function clampMonth(month: string, minMonth: string, maxMonth: string): string {
  return month < minMonth ? minMonth : month > maxMonth ? maxMonth : month;
}

// Derive the canonical step plus the in-scope, forward-only params. Any param
// that belongs to a step later than the derived one is an orphan (a malformed
// or stale deep link) and is dropped, so the returned params are always
// self-consistent with `step`.
export function deriveStep(sp: RawSearchParams): { step: WizardStep; params: WizardParams } {
  const party = validParty(sp.party);
  const date = validDate(sp.date);
  const month = validMonth(sp.month);
  const serviceId = sp.serviceId || undefined;
  const wallStart = sp.wallStart || undefined;
  const hasSlot = Boolean(serviceId && wallStart);

  let step: WizardStep;
  if (party == null) step = "party";
  else if (date == null) step = "date";
  else if (!hasSlot) step = "time";
  else step = "details";

  const params: WizardParams = {};
  const campaign = validCampaign(sp.tk_c);
  if (campaign) params.campaign = campaign; // step-independent — never dropped
  if (party != null) params.party = party;
  if (step === "date" && month) params.month = month;
  // date is non-null once step is time/details (else it'd be the date step);
  // likewise serviceId/wallStart at details (hasSlot was true).
  if (step === "time" || step === "details") params.date = date!;
  if (step === "details") {
    params.serviceId = serviceId!;
    params.wallStart = wallStart!;
  }
  return { step, params };
}

// Build a query string from the kept params (absent keys omitted). Used for
// forward navigation (client) and clear-forward edit links (server).
export function buildStepUrl(params: WizardParams): string {
  const qs = new URLSearchParams();
  if (params.party != null) qs.set("party", String(params.party));
  if (params.date) qs.set("date", params.date);
  if (params.month) qs.set("month", params.month);
  if (params.serviceId) qs.set("serviceId", params.serviceId);
  if (params.wallStart) qs.set("wallStart", params.wallStart);
  if (params.campaign) qs.set("tk_c", params.campaign);
  return qs.toString();
}
