---
description: Delegate a targeted audit (gdpr | payments | security) to a specialist subagent.
allowed-tools: Bash, Read
argument-hint: gdpr | payments | security
---

# /audit <domain>

Run a focused audit on the current diff (or the whole repo if no diff).

## Routing

- `/audit gdpr` → invoke the `gdpr-auditor` subagent.
- `/audit payments` → invoke the `security-reviewer` subagent in payments mode.
- `/audit security` → invoke the `security-reviewer` subagent in general mode.

## What to pass to the subagent

1. The diff (from `git diff main...HEAD`) or a list of files if changes span the whole repo.
2. The relevant playbook: `docs/playbooks/gdpr.md`, `payments.md`, or `security.md`.
3. Any relevant spec being implemented.

## Expected output

A short, structured report:
- **Pass / Fail / Needs clarification.**
- Specific issues with file, line, and which playbook rule is violated.
- Suggested fix per issue.
- Anything that looks new enough it should be added to the playbook.

Do not proceed to ship until failures are resolved or explicitly acknowledged by me.
