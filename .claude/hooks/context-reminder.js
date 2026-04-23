#!/usr/bin/env node
/**
 * UserPromptSubmit hook. Adds a short, non-blocking reminder to keep the
 * agent grounded in the project's rules. Fires on every prompt.
 */

const reminders = [
  "Read docs/specs/<feature>.md and referenced playbooks before coding.",
  "RLS first: every org-scoped table needs a policy in the same migration.",
  "No raw card data. No plaintext PII in logs or error messages.",
  "Forward-only migrations. Drop in two releases, never one.",
  "Small PRs. If the plan is >300 diff lines, split it.",
];

const pick = reminders[Math.floor(Math.random() * reminders.length)];
process.stdout.write(`\n(reminder) ${pick}\n`);
process.exit(0);
