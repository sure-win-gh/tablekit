import { expect, test } from "@playwright/test";

test("health endpoint responds OK", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { ok: boolean; service: string; ts: string };
  expect(body.ok).toBe(true);
  expect(body.service).toBe("tablekit");
  expect(typeof body.ts).toBe("string");
});

test("homepage renders the brand", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "TableKit" })).toBeVisible();
});
