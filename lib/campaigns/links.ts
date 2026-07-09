// Campaign link attribution (marketing-suite Phase B). Pure.
//
// At render time, every link in a campaign email that points at one of our
// public booking surfaces (/book/* or /embed/* on the widget origin) gets
// ?tk_c=<campaignId> appended. The widget wizard carries the param through
// its URL contract and the bookings API stamps it (after re-verifying the
// campaign belongs to the venue) — deterministic, cookieless attribution.
// Non-booking links are never touched.

const BOOKING_PATH_RE = /^\/(book|embed)\//;

export function isBookingSurfaceUrl(url: string, widgetOrigin: string): boolean {
  if (!widgetOrigin) return false;
  try {
    return (
      new URL(url).origin === new URL(widgetOrigin).origin &&
      BOOKING_PATH_RE.test(new URL(url).pathname)
    );
  } catch {
    return false;
  }
}

export function appendCampaignParam(
  url: string,
  campaignId: string | undefined,
  widgetOrigin: string,
): string {
  if (!campaignId || !isBookingSurfaceUrl(url, widgetOrigin)) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has("tk_c")) u.searchParams.set("tk_c", campaignId);
    return u.toString();
  } catch {
    return url;
  }
}
