CREATE TABLE "anchor_claim_events" (
	"id" text PRIMARY KEY NOT NULL,
	"anchor_id" text NOT NULL,
	"claimant_id" text,
	"event_type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anchor_claim_events_type_not_blank" CHECK (length(btrim("anchor_claim_events"."event_type")) > 0),
	CONSTRAINT "anchor_claim_events_actor_check" CHECK ("anchor_claim_events"."actor_type" IN ('system', 'claimant')),
	CONSTRAINT "anchor_claim_events_actor_id_check" CHECK (("anchor_claim_events"."actor_type" = 'system' AND "anchor_claim_events"."actor_id" IS NULL) OR ("anchor_claim_events"."actor_type" = 'claimant' AND length(btrim("anchor_claim_events"."actor_id")) > 0))
);
--> statement-breakpoint
ALTER TABLE "anchor_case_events" DROP CONSTRAINT "anchor_case_events_actor_check";--> statement-breakpoint
ALTER TABLE "anchor_evidence" DROP CONSTRAINT "anchor_evidence_location_check";--> statement-breakpoint
ALTER TABLE "anchor_evidence" DROP CONSTRAINT "anchor_evidence_upload_metadata_check";--> statement-breakpoint
ALTER TABLE "anchor_contact_endpoints" ADD COLUMN "claimant_id" text;--> statement-breakpoint
ALTER TABLE "anchor_contact_endpoints" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "anchor_contact_endpoints" ADD COLUMN "verification_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "anchor_contact_endpoints" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "anchor_disputes" ADD COLUMN "publication_state" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "anchor_claim_events" ADD CONSTRAINT "anchor_claim_events_anchor_id_anchors_id_fk" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_claim_events" ADD CONSTRAINT "anchor_claim_events_claimant_id_anchor_claimants_id_fk" FOREIGN KEY ("claimant_id") REFERENCES "public"."anchor_claimants"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "anchor_claim_events_anchor_occurred_idx" ON "anchor_claim_events" USING btree ("anchor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "anchor_claim_events_claimant_occurred_idx" ON "anchor_claim_events" USING btree ("claimant_id","occurred_at");--> statement-breakpoint
ALTER TABLE "anchor_contact_endpoints" ADD CONSTRAINT "anchor_contact_endpoints_claimant_id_anchor_claimants_id_fk" FOREIGN KEY ("claimant_id") REFERENCES "public"."anchor_claimants"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_contact_endpoints" ADD CONSTRAINT "anchor_contact_endpoints_domain_id_anchor_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."anchor_domains"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_case_events" ADD CONSTRAINT "anchor_case_events_actor_check" CHECK ("anchor_case_events"."actor_type" IN ('system', 'anchor', 'reviewer', 'administrator'));--> statement-breakpoint
ALTER TABLE "anchor_disputes" ADD CONSTRAINT "anchor_disputes_publication_check" CHECK ("anchor_disputes"."publication_state" IN ('internal', 'approved_public'));--> statement-breakpoint
ALTER TABLE "anchor_evidence" ADD CONSTRAINT "anchor_evidence_location_check" CHECK (("anchor_evidence"."kind" = 'link' AND "anchor_evidence"."url" ~ '^https://' AND "anchor_evidence"."storage_reference" IS NULL AND "anchor_evidence"."scan_status" = 'not_required' AND "anchor_evidence"."content_type" IS NULL AND "anchor_evidence"."byte_size" IS NULL AND "anchor_evidence"."sha256" IS NULL AND "anchor_evidence"."scan_result" IS NULL AND "anchor_evidence"."scanned_at" IS NULL) OR ("anchor_evidence"."kind" = 'upload' AND "anchor_evidence"."url" IS NULL AND "anchor_evidence"."storage_reference" ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,511}$' AND "anchor_evidence"."scan_status" = 'clean' AND "anchor_evidence"."scan_result" IS NOT NULL AND "anchor_evidence"."scanned_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "anchor_evidence" ADD CONSTRAINT "anchor_evidence_upload_metadata_check" CHECK ("anchor_evidence"."kind" = 'link' OR ("anchor_evidence"."content_type" IN ('application/pdf', 'image/jpeg', 'image/png', 'text/plain') AND "anchor_evidence"."byte_size" > 0 AND "anchor_evidence"."byte_size" <= 5000000 AND "anchor_evidence"."sha256" ~ '^[0-9a-f]{64}$'));
--> statement-breakpoint
CREATE TRIGGER anchor_claim_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.anchor_claim_events
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.anchor_claim_events FROM PUBLIC;--> statement-breakpoint
COMMENT ON TABLE public.anchor_claim_events IS
  'ANC-04 append-only audit history for domain claims, contacts, and claimant sessions.';
