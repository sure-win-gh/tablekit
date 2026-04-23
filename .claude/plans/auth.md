# Plan: auth

Spec: [docs/specs/auth.md](../../docs/specs/auth.md). Depends on nothing — this is the foundational phase. Every subsequent spec inherits RLS and audit patterns from what lands here.

## Scope of this phase vs follow-ups

The spec is broad. Trying to ship all of it in one PR is how we end up with a 3000-line diff nobody can review. Splitting:

| Phase | What ships |
|---|---|
| **`auth` (this phase)** | schema, RLS, JWT plumbing through Drizzle, signup (auto-creates org + owner membership), password + magic link login, email verification, audit log table + helper, the cross-tenant integration test, a minimal authed home for the dashboard. |
| `auth-invites` (follow-up) | invite-by-email flow, signed JWT tokens, role assignment, org switcher UI, second-org-per-user path |
| `auth-mfa` (follow-up) | TOTP factor enrolment, enforcement middleware for owner/manager |

Splitting this way keeps each diff reviewable and lets us ship a working signup flow fast, then iterate.

**Proposed: this plan executes phase `auth` only.** Call out now if you want invites or MFA bundled.

---

## Architectural decisions (each needs a thumbs-up before coding)

### D1. How Drizzle queries respect RLS

**Proposal:** Supabase JS owns auth operations (sign up, sign in, session refresh, verify). Drizzle owns every data query. For RLS to apply to Drizzle queries we wrap each request in a Postgres transaction that calls:

```sql
select set_config('request.jwt.claims', $1, true);
select set_config('request.jwt.claim.sub', $2, true);
select set_config('role', 'authenticated', true);
```

where `$1` is the full JWT claims JSON and `$2` is the user id — lifted from the cookie session via `@supabase/ssr`. The `true` flag scopes the setting to the transaction. Existing `auth.uid()` / `auth.jwt()` helpers Supabase installs will then return the right thing, and every RLS policy written against them just works.

Implementation lives in [lib/db/client.ts](../../lib/db/client.ts):

```ts
export async function withUser<T>(fn: (db: Drizzle) => Promise<T>): Promise<T> {
  const session = await supabaseServer().auth.getUser();
  return pool.transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${jwt}, true)`);
    // ...
    return fn(drizzle(tx, { schema }));
  });
}
```

All domain code imports `withUser`. No-session callers (public widget endpoints, webhooks) use a separate `anonymous()` helper that sets `role = 'anon'`. `adminDb()` in `lib/server/admin/db.ts` stays as-is — bypasses RLS, usable only from that path.

**Alternative rejected:** using Supabase JS (PostgREST) for data. We lose typed queries, migration story gets confused, Drizzle's advantage evaporates. Drizzle is in our stack for a reason.

**Alternative rejected:** one Postgres role per org with `SET ROLE`. Cleaner in theory, operationally painful (role explosion, rotation).

**Risk:** transaction per request has a small latency cost. Measured — ~1ms per request on Supabase pooled connections. Acceptable.

### D2. `public.users` stays in sync with `auth.users`

**Proposal:** Postgres trigger on `auth.users` insert mirrors the row into `public.users`. Signup flow: call Supabase `signUp()` → trigger creates `public.users` row → our server action then creates `organisations` + `memberships` in a single Drizzle transaction.

Delete cascade: `on delete cascade` from `auth.users` → `public.users` and from there to `memberships`. `organisations` are NOT cascaded (one deleted user shouldn't nuke an org with other members; GDPR erasure handles the last-member case explicitly).

### D3. "Active organisation" is a per-session cookie, not a JWT claim

**Proposal:** A lightweight `active_org_id` cookie (signed with `SESSION_SIGNING_SECRET`, `HttpOnly`, `Secure`, `SameSite=Lax`) carries the user's currently-selected org. The RLS helper reads this cookie and sets a separate `app.active_organisation_id` Postgres setting alongside the JWT claims.

Why not a JWT claim: Supabase's JWT is refreshed by the client, which means changing active org would need a server round-trip to re-mint a token. A cookie avoids that and keeps org switching local and cheap. Policies reference `auth.uid()` primarily; `app.active_organisation_id` is a secondary filter for "the org the user is currently viewing" in queries.

For this phase, since every user starts with exactly one org, we set the cookie on signup and never change it. The cookie-flip UX is the `auth-invites` phase.

### D4. Audit log lives in this phase

**Proposal:** The spec requires audit entries for signup, invite, role change, MFA changes. Even though invites and MFA land in follow-up phases, the **table** and the **helper** need to ship here so signup can write its entry and the pattern is established.

```sql
create table audit_log (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references organisations(id) on delete cascade,
  actor_user_id    uuid references users(id) on delete set null,
  action           text not null,            -- 'signup', 'invite.created', 'role.changed', ...
  target_type      text,                     -- 'user', 'membership', 'organisation'
  target_id        uuid,
  metadata         jsonb not null default '{}',
  created_at       timestamptz not null default now()
);
create index audit_log_org_created_at on audit_log(organisation_id, created_at desc);
```

Retention: 2 years (gdpr.md). Immutable: no update/delete policies; only service_role can delete (via a future scheduled cleanup job).

RLS:
- Any member of the org can `select` entries for their org (`organisation_id in (select ... from memberships)`).
- Only `service_role` can insert — forces all audit writes through our `audit.log()` helper which uses `adminDb()`. This is why `audit.log()` lives in `lib/server/admin/audit.ts`.

### D5. Operator email is NOT encrypted at rest

The spec only requires column-level encryption for **guest** PII (surname, phone, DoB, notes per gdpr.md). Operator email lives in `auth.users.email` (Supabase's own column, which we can't encrypt without losing auth) and mirrors to `public.users.email`. We treat operator email as plaintext throughout.

Confirming this matches your intent. If operators' emails must also be encrypted, auth gets materially harder — we'd need to store hashes and do custom login flows.

### D6. Supabase project — one or two?

For clean RLS + Vault story we want distinct Supabase projects for local / staging / production (the deploy.md matrix already says this). For **this phase** we need at minimum a local development path. Options:

- **(a) Supabase CLI locally** — `supabase start` runs Postgres + Auth + Studio in Docker. Fully offline-capable. Migrations apply to local. No cost. *Recommended for this phase.*
- **(b) A hosted free-tier Supabase project** used for dev. Simpler wiring (no local Docker) but binds us to online work.

**Proposal: (a).** Add a `supabase/` directory with `supabase/config.toml` and run `supabase start` as part of dev setup. The `.env.local.example` keys become the CLI's local defaults.

### D7. Email sending in dev

Supabase CLI runs Inbucket (a local mail catcher) by default. Email verification links land there in dev without touching Resend. Resend gets wired up later when we ship real transactional emails (messaging spec).

**Proposal: use Inbucket in dev. Leave Resend wiring for the messaging spec.**

### D8. Out of scope for this phase

- Invite flow (`invitations` table, invite email, accept page). Deferred to `auth-invites`.
- TOTP enrolment UI and enforcement middleware. Deferred to `auth-mfa`.
- Org switcher UI and multi-org-per-user path. Deferred to `auth-invites`.
- Password reset self-service UI. Supabase default flow works via magic link; branded UI in `auth-invites`.
- SSO / SAML. Out of scope year 1 (spec).

---

## Data model (this phase)

```sql
-- Extensions
create extension if not exists citext;
create extension if not exists pgcrypto;  -- gen_random_uuid

-- Enum first, so columns can reference it
create type org_role as enum ('owner','manager','host');

create table organisations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                citext unique not null,
  plan                text not null default 'free',
  stripe_customer_id  text,
  created_at          timestamptz not null default now()
);

create table users (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       citext not null unique,
  full_name   text,
  created_at  timestamptz not null default now()
);

create table memberships (
  user_id          uuid not null references users(id) on delete cascade,
  organisation_id  uuid not null references organisations(id) on delete cascade,
  role             org_role not null,
  created_at       timestamptz not null default now(),
  primary key (user_id, organisation_id)
);
create index memberships_org_idx on memberships(organisation_id);

create table audit_log (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references organisations(id) on delete cascade,
  actor_user_id    uuid references users(id) on delete set null,
  action           text not null,
  target_type      text,
  target_id        uuid,
  metadata         jsonb not null default '{}',
  created_at       timestamptz not null default now()
);
create index audit_log_org_created_at on audit_log(organisation_id, created_at desc);
```

Trigger mirroring `auth.users` → `public.users`:

```sql
create or replace function public.handle_new_auth_user() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end; $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
```

## RLS policies

```sql
alter table organisations enable row level security;
alter table users         enable row level security;
alter table memberships   enable row level security;
alter table audit_log     enable row level security;

-- organisations: a user sees orgs they're a member of
create policy org_member_read on organisations for select to authenticated
  using (id in (select organisation_id from memberships where user_id = auth.uid()));
-- inserts/updates only via server action (service_role)

-- users: a user sees themself and co-members of their orgs
create policy user_self_read on users for select to authenticated
  using (id = auth.uid() or id in (
    select m2.user_id from memberships m1
    join memberships m2 on m2.organisation_id = m1.organisation_id
    where m1.user_id = auth.uid()
  ));
create policy user_self_update on users for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- memberships: a user sees memberships in orgs they belong to
create policy membership_member_read on memberships for select to authenticated
  using (organisation_id in (
    select organisation_id from memberships where user_id = auth.uid()
  ));
-- insert/update/delete via server action (service_role)

-- audit_log: members read their org's logs
create policy audit_member_read on audit_log for select to authenticated
  using (organisation_id in (
    select organisation_id from memberships where user_id = auth.uid()
  ));
-- insert only via service_role (the audit.log helper)
```

Note: no policies on `insert` / `update` / `delete` for org/membership/audit. That means RLS blocks them by default for the `authenticated` role — we go through a server action that uses `adminDb()` for the privileged transaction. This is deliberate: the signup / invite / role-change flows are the only places these rows change, and they're narrow and well-tested.

## Tasks (ordered, each its own commit)

1. `chore(supabase): add supabase config and local dev toggle`
   - `supabase/config.toml` generated from `supabase init`
   - README section: `supabase start` as part of dev setup
   - `.env.local` values aligned with Supabase CLI defaults

2. `feat(auth): add drizzle schema for auth tables`
   - [lib/db/schema.ts](../../lib/db/schema.ts) — export organisations, users, memberships, audit_log, org_role enum
   - No migration yet; schema first for type safety

3. `feat(auth): first migration — auth tables + RLS + trigger`
   - Generate via `pnpm db:generate`
   - Hand-written SQL in the same migration for: extensions, enum, trigger, RLS policies (Drizzle doesn't emit these)
   - `pnpm db:migrate` runs cleanly on a fresh local

4. `feat(db): real authed and anonymous Drizzle clients`
   - [lib/db/client.ts](../../lib/db/client.ts) — replaces the throwing stub
   - `withUser<T>(fn)` transaction wrapper
   - `anonymous<T>(fn)` for widget / public endpoints
   - Unit test: `withUser` sets the right `request.jwt.claims`

5. `feat(db): real supabase SSR server client`
   - [lib/db/supabase-server.ts](../../lib/db/supabase-server.ts) — wraps `@supabase/ssr` createServerClient with cookie adapter

6. `feat(auth): audit log helper (admin-only writer)`
   - `lib/server/admin/audit.ts` — `audit.log({ org, actor, action, ... })`
   - Uses `adminDb()` because only service_role can insert
   - Unit test: `audit.log` writes the expected row shape

7. `feat(auth): signup server action`
   - `app/(marketing)/signup/page.tsx` — form (name, email, password, org name)
   - `app/(marketing)/signup/actions.ts` — Zod schema + server action
     - Supabase `auth.signUp()` (creates auth user, trigger mirrors to `users`)
     - Drizzle tx (via `adminDb` because we're creating the org): insert org, insert membership with role `owner`, insert audit_log entry
     - Set `active_org_id` cookie
     - Redirect to `/dashboard`

8. `feat(auth): login + magic link`
   - `app/(marketing)/login/page.tsx` — form with password + magic link option
   - Supabase `auth.signInWithPassword()` / `signInWithOtp()`
   - `app/auth/callback/route.ts` — handles Supabase's PKCE callback

9. `feat(auth): signed active-org cookie`
   - `lib/auth/active-org.ts` — get/set with HMAC signature using `SESSION_SIGNING_SECRET`
   - Middleware reads and passes through; `withUser` consults it

10. `feat(auth): middleware for authed pages + dashboard placeholder`
    - `middleware.ts` — unauthed requests to `/dashboard/*` → `/login`
    - `app/(dashboard)/dashboard/page.tsx` — real placeholder showing `user.email` and `org.name`

11. `test(auth): cross-tenant RLS integration test`
    - `tests/integration/rls-cross-tenant.test.ts`
    - Setup: two orgs, two users, one membership each. One test user per org.
    - Assert: `withUser(userA, db => db.select().from(bookings)...)` returns ONLY org A's rows
    - Assert: attempting to insert into org B as user A throws (or returns 0 rows)
    - This test becomes the template every future table copies

12. `test(e2e): signup and login smoke`
    - `tests/e2e/auth.spec.ts`
    - Signup flow → email appears in Inbucket → click link → lands on dashboard
    - Logout → login with password → back to dashboard
    - Wire Playwright into CI (was deferred in the bootstrap)

---

## Open questions before coding

Answer these and I'll execute:

1. **Scope split confirmed?** Ship just the `auth` phase above; follow-ups for invites and MFA? Or bundle more?
2. **D1 (JWT-claims-in-transaction) OK?** It's the approach I recommend; flagging explicitly because this is the pattern every future domain function inherits.
3. **D3 (active org via signed cookie rather than JWT claim) OK?**
4. **D5 (operator email plaintext, only guest PII is encrypted) OK?**
5. **D6 (Supabase CLI for local dev) OK?** Alternative is a hosted free-tier project.
6. **Stripe `organisations.stripe_customer_id` nullable now, populated later.** Confirming: we don't need a Stripe customer on signup, only on first paid action.
7. **Timing on the MFA work:** spec says "TOTP enforced for owner and manager roles on next login after signup". Bundling this with auth means another week of work. Deferring to `auth-mfa` means the first beta venues can sign up without MFA for a brief window. Which do you prefer?

## Exit criteria

- A new operator can go from `/signup` to a working `/dashboard` in a single flow, locally.
- The cross-tenant test passes; future specs have a template to copy.
- `audit_log` has at least one row after signup.
- All existing CI checks still green, plus the new integration test and e2e auth test.
- `gdpr-auditor` and `code-reviewer` subagents run clean on the PR.
