ALTER TABLE "booking_tables" DROP CONSTRAINT "booking_tables_table_id_tables_id_fk";
--> statement-breakpoint
ALTER TABLE "booking_tables" ADD CONSTRAINT "booking_tables_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;