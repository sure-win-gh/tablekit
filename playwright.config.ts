import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// Load .env.local first (Next.js precedence), then .env. Teardown
// hooks use admin API keys read from process.env; the dev server
// spawned by webServer also inherits the loaded values.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const baseURL = process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:3000";
const isCI = Boolean(process.env["CI"]);

// Production always sits behind infrastructure that supplies a client IP
// header; hitting localhost directly supplies none, so ipFromHeaders() falls
// back to "unknown" and every login in every run and retry shares the single
// `login:ip:unknown` bucket — 5 attempts per 15 minutes for the whole of CI.
// Send a realistic per-run address instead. TEST-NET-3 (RFC 5737) is reserved
// for documentation and can never be a real client.
const runNumber = Number(process.env["GITHUB_RUN_NUMBER"]);
const clientIpOctet = Number.isFinite(runNumber)
  ? runNumber % 250
  : Math.floor(Math.random() * 250);
const clientIp = `203.0.113.${clientIpOctet}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  ...(isCI ? { workers: 1 } : {}),
  reporter: isCI ? [["github"], ["list"]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    extraHTTPHeaders: { "x-real-ip": clientIp },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // CI serves a production build. Under `next dev` every route compiles on
    // first request and hydration lands late, which the bookings spec hit
    // head-on: the page rendered but never became interactive inside the test,
    // so the date input's onChange never fired. The e2e job builds first (see
    // .github/workflows/ci.yml), and this also puts e2e closer to what ships.
    // Locally it stays `pnpm dev`, reusing a server you already have running.
    command: isCI ? "pnpm start" : "pnpm dev",
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
