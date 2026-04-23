# Spec: Authentication, organisations, roles

**Status:** draft
**Depends on:** nothing (this is foundational)

## What we're building

Operator-side authentication and multi-tenant organisation model. Guests never sign in — they book via a public widget.

## Entities

- `organisations` — a customer account; one billing subscription per org.
- `users` — a person who can log into one or more organisations.
- `memberships` — user ↔ organisation with a `role`.
- `roles`: `owner` (full access + billing), `manager` (everything except billing), `host` (day-of operations only).

## User stories

- As a prospective operator I can sign up with email + password, verify email, and be put into a fresh organisation as `owner`.
- As an owner I can invite a teammate by email; they get a signup link and are added with the role I specified.
- As any user I can belong to multiple organisations and switch between them.
- As an owner/manager I must set up TOTP MFA; MFA is optional for hosts.
- As any user I can reset my password via magic link.

## Acceptance criteria

- [ ] Signup creates user, organisation, membership in one transaction.
- [ ] Email verification required before first dashboard login.
- [ ] Supabase Auth used as the identity provider.
- [ ] Organisation switcher visible in the dashboard nav.
- [ ] TOTP enforced for `owner` and `manager` roles on next login after signup.
- [ ] Row-level security policies: a user can only read data for organisations they are a member of. Enforced at the DB layer, not just the app.
- [ ] Integration test proves RLS isolation across two organisations.
- [ ] Audit log entry on signup, invite, role change, MFA enrol/disable.

## Data model (starting point)

```sql
create table organisations (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         citext unique not null,
  plan         text not null default 'free',
  stripe_customer_id text,
  created_at   timestamptz not null default now()
);

create table users (
  id           uuid primary key,               -- mirrors auth.users.id
  email        citext not null unique,
  full_name    text,
  created_at   timestamptz not null default now()
);

create type org_role as enum ('owner','manager','host');

create table memberships (
  user_id         uuid references users(id) on delete cascade,
  organisation_id uuid references organisations(id) on delete cascade,
  role            org_role not null,
  created_at      timestamptz not null default now(),
  primary key (user_id, organisation_id)
);
```

## RLS policies (template)

```sql
alter table organisations enable row level security;
create policy org_member_read on organisations
  for select using (
    id in (select organisation_id from memberships where user_id = auth.uid())
  );
```

## Security notes

- Passwords via Supabase Auth (argon2id).
- All auth endpoints rate-limited at Cloudflare.
- Invite tokens single-use, 72h expiry, signed JWTs.

## Out of scope

- SSO/SAML (add in year 2 when we sell to groups).
- Passkey/WebAuthn (month 6+).
