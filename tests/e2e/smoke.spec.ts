import { expect, test } from "@playwright/test";

test("health endpoint responds OK", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { ok: boolean; service: string; ts: string };
  expect(body.ok).toBe(true);
  expect(body.service).toBe("tablekit");
  expect(typeof body.ts).toBe("string");
});

test("home renders the hero and the primary sign-up CTA", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Primary CTA everywhere is free sign-up into the existing flow.
  const ctas = page.getByRole("link", { name: /start free/i });
  await expect(ctas.first()).toBeVisible();
  await expect(ctas.first()).toHaveAttribute("href", "/signup");
});

test("pricing shows the three tiers with + VAT honesty", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("£29").first()).toBeVisible();
  await expect(page.getByText("£74").first()).toBeVisible();
  await expect(page.getByText(/\+ VAT/i).first()).toBeVisible();
});

test("features index links through to a live feature deep-dive", async ({ page }) => {
  await page.goto("/features");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto("/features/deposits");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /start free/i }).first()).toBeVisible();
});
