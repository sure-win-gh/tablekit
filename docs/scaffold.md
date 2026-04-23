# TableKit — Claude Code scaffolding

This folder is a ready-to-drop-in scaffolding for vibe-coding **TableKit**, a low-cost UK table-booking SaaS for independent hospitality, using Claude Code.

It doesn't contain a running app — it contains the project's **brain**: the spec, the playbooks, the slash commands, the subagents, and the guardrails. The idea is: copy this into an empty repo, rename one folder, paste the bootstrap prompt into Claude Code, and start shipping.

## What's in here

```
table-booking-scaffold/
├── CLAUDE.md                    # project-wide instructions Claude reads first
├── BOOTSTRAP_PROMPT.md          # paste this into Claude Code once, on a fresh repo
├── README.md                    # you are here
├── docs/
│   ├── specs/                   # one markdown file per feature
│   │   ├── index.md
│   │   ├── auth.md
│   │   ├── venues.md
│   │   ├── bookings.md
│   │   ├── widget.md
│   │   ├── payments.md
│   │   ├── messaging.md
│   │   ├── guests.md
│   │   ├── waitlist.md
│   │   ├── reserve-with-google.md
│   │   ├── reporting.md
│   │   ├── multi-venue.md       (Plus)
│   │   ├── ai-enquiry.md        (Plus)
│   │   ├── import-export.md
│   │   └── public-api.md        (Plus)
│   └── playbooks/               # cross-cutting rules Claude must follow
│       ├── gdpr.md
│       ├── payments.md
│       ├── security.md
│       ├── incident.md
│       └── deploy.md
└── claude-config/               # RENAME to .claude/ after copying
    ├── settings.json            # permissions + hooks
    ├── commands/                # custom slash commands
    │   ├── ship.md
    │   ├── spec.md
    │   ├── plan-feature.md
    │   ├── migrate.md
    │   ├── review.md
    │   └── audit.md
    ├── agents/                  # subagents for focused reviews
    │   ├── code-reviewer.md
    │   ├── gdpr-auditor.md
    │   └── security-reviewer.md
    └── hooks/                   # shell hooks wired from settings.json
        ├── guard-pii.js
        └── context-reminder.js
```

## Install

1. Create an empty git repo for the project.
2. Copy the contents of this folder into the repo root.
3. **Rename `claude-config/` to `.claude/`.** (This bundle ships as `claude-config/` because the build environment couldn't write to a dotfile folder directly.)
4. `chmod +x .claude/hooks/*.js` so the hooks can run.
5. Open the repo in Claude Code.
6. Paste `BOOTSTRAP_PROMPT.md` into Claude Code.

From then on, Claude Code will:
- Always read `CLAUDE.md` first.
- Pull in the relevant spec for whatever you're shipping.
- Run PII / secret guards on every write.
- Use subagents for reviews before merges.

## How to work with this scaffold

**Starting a feature:**
```
/plan-feature bookings
```
Claude drafts a plan at `.claude/plans/bookings.md`. Read it. Ask for tweaks. Don't let it code yet.

**Shipping:**
```
/ship bookings
```
Claude implements in small commits, runs checks, opens a PR.

**Reviewing before merge:**
```
/review
/audit gdpr
/audit payments     # only when the diff touches money
```

**Writing a new spec:**
```
/spec loyalty-points
```

**Generating a DB migration:**
```
/migrate add optional venue_slug to venues
```

## What the playbooks do

- **gdpr.md** — we are a data processor, venue is controller, sub-processor list, retention, erasure, DSAR flow. Read before touching any personal data.
- **payments.md** — PCI SAQ-A scope, Stripe Connect Standard, webhook idempotency, what we never store. Read before touching anything money-related.
- **security.md** — auth, RLS, secrets, rate limiting, headers, cross-tenant prevention. The baseline.
- **incident.md** — severity levels, kill switches, rollback, breach path. Read when things are broken or boring, never when you're panicking.
- **deploy.md** — environments, migrations, release flow, pre-launch checklist.

## What the subagents do

- **code-reviewer** — correctness, RLS, tests, style. General-purpose.
- **gdpr-auditor** — only cares about GDPR. Aggressive, narrow, useful.
- **security-reviewer** — auth, payments (SAQ-A), webhooks. Has a payments-mode.

Each one has its own system prompt, loaded from `.claude/agents/<name>.md` at invocation.

## What the hooks do

- **guard-pii.js** — PreToolUse hook. Blocks writes that look like: secrets in code, plaintext PII being logged, raw card data, service_role client outside the admin surface.
- **context-reminder.js** — UserPromptSubmit hook. Drops a one-line reminder into every prompt to keep Claude honest about the rules.

## Customising

- All rules live in markdown. Edit a playbook, Claude changes behaviour on the next prompt.
- Commercial model lives in `CLAUDE.md`. Update pricing or non-goals there.
- Add new subagents in `.claude/agents/`, reference them from `/audit` or a new slash command.

## What this scaffold is NOT

- It is not a running codebase. You still need to bootstrap the Next.js app (the bootstrap prompt tells Claude Code to do this).
- It is not a silver bullet. Claude Code will still make mistakes. The playbooks and subagents are designed to catch the most expensive ones.
- It is not stable forever. Reconsider the shape of the scaffolding every few months — what rules are being ignored, what rules are missing, what feedback loops are slow.

## A note on the folder name

Claude Code reads config from a folder literally named `.claude/`. This bundle was built in a sandbox that couldn't write to dotfile folders, so the directory ships as `claude-config/`. Rename it to `.claude/` and you're set.
