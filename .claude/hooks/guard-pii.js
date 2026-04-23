#!/usr/bin/env node
/**
 * PreToolUse hook. Blocks obvious mistakes before they hit disk:
 *   - logging or returning plaintext guest PII fields
 *   - hardcoded secrets, Stripe test/live keys, API tokens
 *   - use of service_role Supabase client outside lib/server/admin
 *
 * Hook input is JSON on stdin; on block we exit non-zero and print to stderr.
 */

const { readFileSync } = require("fs");

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const file = input?.tool_input?.file_path || "";
const content = input?.tool_input?.content || input?.tool_input?.new_string || "";

if (!content || typeof content !== "string") process.exit(0);

const problems = [];

// Secrets and keys that should never be committed.
const secretPatterns = [
  [/\bsk_live_[A-Za-z0-9]{16,}/g, "Stripe live secret key"],
  [/\bsk_test_[A-Za-z0-9]{16,}/g, "Stripe test secret key (use env var)"],
  [/\brk_live_[A-Za-z0-9]{16,}/g, "Stripe restricted live key"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AWS access key"],
  [/-----BEGIN (RSA )?PRIVATE KEY-----/g, "private key material"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./g, "JWT-looking token"],
];

for (const [re, label] of secretPatterns) {
  if (re.test(content)) problems.push(`secret detected: ${label}`);
}

// Plaintext PII logging / leaking.
const piiLog = [
  /console\.(log|info|warn|error)\([^)]*(email|phone|last_?name|dob|date_of_birth|notes)/i,
  /logger\.\w+\([^)]*(email|phone|last_?name|dob|date_of_birth|notes)/i,
  /Sentry\.captureException[^)]*(email|phone|last_?name|dob|date_of_birth|notes)/i,
];

for (const re of piiLog) {
  if (re.test(content)) {
    problems.push("plaintext PII in log/error path — use ids, not contact fields");
    break;
  }
}

// service_role client outside admin surface.
if (/service_role/i.test(content) && !file.includes("lib/server/admin/") && !file.endsWith(".md")) {
  problems.push("service_role Supabase client used outside lib/server/admin/");
}

// Raw card data references.
if (/\b(cardNumber|card_number|pan|cvv|cvc)\b/i.test(content) && !file.endsWith(".md")) {
  problems.push("raw card data identifiers in code — SAQ-A scope forbids this");
}

if (problems.length) {
  console.error("guard-pii blocked write: " + problems.join("; "));
  process.exit(2); // non-zero to block the tool call
}

process.exit(0);
