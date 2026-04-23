---
description: Draft or update a feature spec in docs/specs.
allowed-tools: Read, Write, Edit, Grep, Glob
---

# /spec <feature-name>

Draft a new spec or update an existing one under `docs/specs/<feature-name>.md`.

Every spec must contain these sections, in this order:

1. Title and status.
2. **Depends on** — other specs and playbooks.
3. **What we're building** — one paragraph, plain English, no jargon.
4. **User stories** — "As a <role> I can <action>."
5. **Data model** — SQL DDL for new or modified tables.
6. **API surface** — routes / server actions added or changed.
7. **Acceptance criteria** — a checklist with measurable, testable items.
8. **Out of scope** — what this spec deliberately does not cover.

## Rules

- Keep it short. A good spec fits on one screen plus one scroll. If it's longer, split it.
- No ASCII art, no "roadmap," no "vision." This is engineering scope, not marketing.
- If it touches PII, reference `docs/playbooks/gdpr.md` in Depends on.
- If it touches cards/payments, reference `docs/playbooks/payments.md`.
- If it introduces new infrastructure, update `docs/playbooks/deploy.md` in the same PR.
- Don't start implementing anything. This command only writes the spec and stops.
