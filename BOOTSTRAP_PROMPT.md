# Bootstrap prompt

Paste this into Claude Code once, on a fresh project, after you've copied this scaffolding into the repo root and renamed `claude-config/` to `.claude/`.

---

You are working with me (Ben, the solo operator) to build TableKit, a low-cost UK table-booking SaaS for independent hospitality. I have some coding experience but you are doing the heavy lifting. My budget is under £100/month of infrastructure. We ship publicly from day one and iterate in the open.

Before you do anything else, read these files in order. Do not skip any. Report back with a one-paragraph summary of how you understand the project:

1. `CLAUDE.md`
2. `docs/specs/index.md`
3. `docs/playbooks/gdpr.md`
4. `docs/playbooks/payments.md`
5. `docs/playbooks/security.md`
6. `docs/playbooks/deploy.md`
7. `docs/playbooks/incident.md`

After you've summarised, initialise the project skeleton:

1. Create a Next.js 15 app with TypeScript strict mode, App Router, Tailwind.
2. Install the canonical stack listed in `CLAUDE.md`: Drizzle, Supabase JS, Stripe, Resend, Twilio, Zod, Vitest, Playwright.
3. Set up the repo layout exactly as described in `CLAUDE.md`.
4. Wire up `scripts/check-rls.ts` that fails CI if any Postgres table has RLS disabled.
5. Add a `.env.local.example` listing every env var we'll need, with safe placeholder values.
6. Add a `README.md` for humans explaining how to run locally.
7. Commit in small, logical commits with conventional messages. Push when I tell you to.

Use Plan mode for anything that spans more than one file, and always produce a plan at `.claude/plans/<feature>.md` before coding. Use the `/spec`, `/plan-feature`, `/ship`, `/migrate`, `/review`, `/audit` slash commands where they fit.

When you are unsure: stop and ask me. Do not improvise on architecture, on data model choices, or on anything touching PII or payments.

When you reach a stopping point, summarise what was done and propose the next spec to tackle. Our rough MVP order is: `auth → venues → bookings → widget → payments → messaging → guests → waitlist → reserve-with-google → reporting`. Skip `reserve-with-google` past the API stubs until our Google partner onboarding lands.

Go.
