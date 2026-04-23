-- =============================================================================
-- 0000: auth foundation — organisations, users, memberships, audit log + RLS
-- =============================================================================
--
-- This migration is the template every future tenant-scoped table copies.
-- The top half (schema) is Drizzle-generated from lib/db/schema.ts; the
-- bottom half (extensions, auth.users FK, trigger, RLS policies) is
-- hand-written because Drizzle doesn't model any of those constructs.
--
-- Anything you edit manually below survives future `pnpm db:generate`
-- runs (they produce new 0001_*.sql files; they don't rewrite this one).
-- =============================================================================

-- --- Extensions --------------------------------------------------------------
-- pgcrypto: gen_random_uuid() for DEFAULT uuid ids.
-- citext:   case-insensitive text for email / slug uniqueness.
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TYPE "public"."org_role" AS ENUM('owner', 'manager', 'host');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"role" "org_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_id_organisation_id_pk" PRIMARY KEY("user_id","organisation_id")
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" "citext" NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"full_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_created_at" ON "audit_log" USING btree ("organisation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memberships_org_idx" ON "memberships" USING btree ("organisation_id");--> statement-breakpoint

-- --- FK to Supabase's auth.users (hand-added; Drizzle doesn't model auth) ----
-- Keeps public.users.id in lock-step with auth.users.id. ON DELETE CASCADE
-- so deleting a Supabase user cleans up downstream rows.
ALTER TABLE "users"
  ADD CONSTRAINT "users_id_auth_users_id_fk"
  FOREIGN KEY ("id") REFERENCES auth.users(id)
  ON DELETE CASCADE;--> statement-breakpoint

-- --- Trigger: auth.users insert → public.users ------------------------------
-- SECURITY DEFINER so the function runs with the table owner's privileges
-- (Supabase's auth schema is owned by supabase_auth_admin, which is why
-- plain inserts from auth.users triggers need this dance).
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
--> statement-breakpoint

-- --- RLS helper functions ---------------------------------------------------
-- These return the set of orgs (and peer user ids) the current auth user
-- belongs to, bypassing RLS via SECURITY DEFINER. Without this wrapper,
-- membership policies that subquery memberships recurse infinitely.
CREATE OR REPLACE FUNCTION public.user_organisation_ids()
  RETURNS SETOF uuid
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT organisation_id
  FROM public.memberships
  WHERE user_id = auth.uid();
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.user_organisation_peer_ids()
  RETURNS SETOF uuid
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT DISTINCT m2.user_id
  FROM public.memberships m1
  JOIN public.memberships m2 ON m2.organisation_id = m1.organisation_id
  WHERE m1.user_id = auth.uid();
$$;
--> statement-breakpoint

-- --- Row Level Security -----------------------------------------------------
ALTER TABLE "organisations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users"         ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships"   ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log"     ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- organisations: members read their orgs. Inserts/updates go through
-- server actions backed by service_role (adminDb()).
CREATE POLICY "org_member_read" ON "organisations"
  FOR SELECT TO authenticated
  USING (id IN (SELECT public.user_organisation_ids()));
--> statement-breakpoint

-- users: a user reads themself, plus anyone in their orgs.
CREATE POLICY "user_self_or_peer_read" ON "users"
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR id IN (SELECT public.user_organisation_peer_ids())
  );
--> statement-breakpoint
-- users: a user can update their own row only.
CREATE POLICY "user_self_update" ON "users"
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());
--> statement-breakpoint

-- memberships: members read memberships in their orgs.
CREATE POLICY "membership_member_read" ON "memberships"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
--> statement-breakpoint

-- audit_log: members read their org's log entries.
-- Inserts are service_role only — writes go through the audit.log() helper.
CREATE POLICY "audit_member_read" ON "audit_log"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
