// Dismisses the privacy/cookie notice that components/cookie-notice.tsx
// renders on the marketing and widget surfaces.
//
// It sits at the bottom of the viewport and can intercept clicks on anything
// underneath. Dismissal is a real button that persists to localStorage, so one
// click per browser context is enough — it does not come back on navigation.
// Call it after the first goto, once the page (and therefore the origin's
// localStorage) exists.

import type { Page } from "@playwright/test";

export async function dismissCookieNotice(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: "Dismiss" });
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click();
    await dismiss.waitFor({ state: "hidden", timeout: 5_000 });
  }
}
