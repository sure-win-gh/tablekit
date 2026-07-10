CREATE TABLE "campaign_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"subject" text,
	"body_doc" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_templates" ADD CONSTRAINT "campaign_templates_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_templates" ADD CONSTRAINT "campaign_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_templates_org_idx" ON "campaign_templates" USING btree ("organisation_id");--> statement-breakpoint
-- Org members can read their own templates (the builder's picker). ALL
-- writes go through org-guarded server actions via adminDb(), so no
-- INSERT/UPDATE/DELETE policy for the authenticated role. Mirrors the
-- billing_* member-read posture in 0047.
ALTER TABLE "campaign_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "campaign_templates_member_read" ON "campaign_templates"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));