ALTER TABLE "discrepancy_events" DROP CONSTRAINT "discrepancy_events_target_event_fk";
--> statement-breakpoint
ALTER TABLE "discrepancy_events" ADD CONSTRAINT "discrepancy_events_identity_context_unique" UNIQUE("id","discrepancy_id");--> statement-breakpoint
ALTER TABLE "discrepancy_events" ADD CONSTRAINT "discrepancy_events_target_event_fk" FOREIGN KEY ("target_event_id","discrepancy_id") REFERENCES "public"."discrepancy_events"("id","discrepancy_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "discrepancy_events" ADD CONSTRAINT "discrepancy_events_target_not_self" CHECK ("discrepancy_events"."target_event_id" IS NULL OR "discrepancy_events"."target_event_id" <> "discrepancy_events"."id");--> statement-breakpoint
ALTER TABLE "discrepancy_events" ADD CONSTRAINT "discrepancy_events_target_required_check" CHECK (("discrepancy_events"."event_type" IN ('resolved', 'corrected', 'retracted') AND "discrepancy_events"."target_event_id" IS NOT NULL) OR
          ("discrepancy_events"."event_type" NOT IN ('resolved', 'corrected', 'retracted') AND "discrepancy_events"."target_event_id" IS NULL));
