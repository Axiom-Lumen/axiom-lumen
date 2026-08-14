CREATE TABLE "anchor_verification_events" (
	"id" text PRIMARY KEY NOT NULL,
	"anchor_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"event_type" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anchor_verification_events_type_check" CHECK ("anchor_verification_events"."event_type" IN ('verified', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "anchor_domains" ADD COLUMN "verification_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "anchor_verification_events" ADD CONSTRAINT "anchor_verification_events_anchor_id_anchors_id_fk" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_verification_events" ADD CONSTRAINT "anchor_verification_events_domain_id_anchor_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."anchor_domains"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_verification_events" ADD CONSTRAINT "anchor_verification_events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "anchor_verification_events_anchor_occurred_idx" ON "anchor_verification_events" USING btree ("anchor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "anchor_verification_events_domain_occurred_idx" ON "anchor_verification_events" USING btree ("domain_id","occurred_at");--> statement-breakpoint
CREATE TRIGGER anchor_verification_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.anchor_verification_events
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.anchor_verification_events FROM PUBLIC;
