import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Claude hooks are CommonJS Node scripts run by the agent runtime,
    // not part of the Next.js app; linting them with the app's TS
    // config adds no value.
    ".claude/hooks/**",
  ]),
  {
    rules: {
      // Underscore-prefixed params are the signal that a stub is
      // deliberately ignoring them. Honoured widely elsewhere; the
      // default Next preset doesn't opt in.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;
