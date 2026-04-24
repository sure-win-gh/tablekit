import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    exclude: ["node_modules", ".next", "tests/e2e/**"],
    setupFiles: ["tests/unit/setup.ts"],
    globals: false,
    clearMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: ["node_modules/", ".next/", "tests/", "**/*.config.{ts,mjs,js}", "drizzle/"],
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
      // Same reason as tests/integration/vitest.config.ts: the real
      // `server-only` package errors when imported outside a server
      // component, which includes unit tests. Shim it out.
      "server-only": resolve(__dirname, "tests/integration/server-only-shim.ts"),
    },
  },
});
