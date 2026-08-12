CREATE TABLE "anchor_claim_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"anchor_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"verification_path" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anchor_claim_challenges_hash_check" CHECK ("anchor_claim_challenges"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "anchor_claim_challenges_expiry_check" CHECK ("anchor_claim_challenges"."expires_at" > "anchor_claim_challenges"."created_at"),
	CONSTRAINT "anchor_claim_challenges_consumed_check" CHECK ("anchor_claim_challenges"."consumed_at" IS NULL OR "anchor_claim_challenges"."consumed_at" <= "anchor_claim_challenges"."expires_at")
);
--> statement-breakpoint
CREATE TABLE "anchor_claim_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"claimant_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anchor_claim_sessions_hash_check" CHECK ("anchor_claim_sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "anchor_claim_sessions_expiry_check" CHECK ("anchor_claim_sessions"."expires_at" > "anchor_claim_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "anchor_claimants" (
	"id" text PRIMARY KEY NOT NULL,
	"anchor_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"verification_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anchor_claimants_expiry_check" CHECK ("anchor_claimants"."verification_expires_at" > "anchor_claimants"."verified_at"),
	CONSTRAINT "anchor_claimants_revoked_check" CHECK ("anchor_claimants"."revoked_at" IS NULL OR "anchor_claimants"."revoked_at" >= "anchor_claimants"."verified_at")
);
--> statement-breakpoint
CREATE TABLE "anchor_disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"flag_id" text NOT NULL,
	"case_id" text,
	"claimant_id" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anchor_disputes_body_not_blank" CHECK (length(btrim("anchor_disputes"."body")) > 0),
	CONSTRAINT "anchor_disputes_status_check" CHECK ("anchor_disputes"."status" IN ('open', 'under_review', 'resolved', 'rejected')),
	CONSTRAINT "anchor_disputes_resolution_check" CHECK (("anchor_disputes"."status" IN ('resolved', 'rejected')) = ("anchor_disputes"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "anchor_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"reply_id" text,
	"dispute_id" text,
	"kind" text NOT NULL,
	"url" text,
	"storage_reference" text,
	"content_type" text,
	"byte_size" bigint,
	"sha256" text,
	"scan_status" text NOT NULL,
	"scan_result" jsonb,
	"scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anchor_evidence_parent_check" CHECK (("anchor_evidence"."reply_id" IS NOT NULL)::int + ("anchor_evidence"."dispute_id" IS NOT NULL)::int = 1),
	CONSTRAINT "anchor_evidence_kind_check" CHECK ("anchor_evidence"."kind" IN ('link', 'upload')),
	CONSTRAINT "anchor_evidence_location_check" CHECK (("anchor_evidence"."kind" = 'link' AND "anchor_evidence"."url" IS NOT NULL AND "anchor_evidence"."storage_reference" IS NULL) OR ("anchor_evidence"."kind" = 'upload' AND "anchor_evidence"."url" IS NULL AND "anchor_evidence"."storage_reference" IS NOT NULL)),
	CONSTRAINT "anchor_evidence_scan_status_check" CHECK ("anchor_evidence"."scan_status" IN ('not_required', 'pending', 'clean', 'rejected')),
	CONSTRAINT "anchor_evidence_upload_metadata_check" CHECK ("anchor_evidence"."kind" = 'link' OR ("anchor_evidence"."content_type" IS NOT NULL AND "anchor_evidence"."byte_size" > 0 AND "anchor_evidence"."sha256" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "anchor_replies" ADD COLUMN "claimant_id" text;--> statement-breakpoint
ALTER TABLE "anchor_replies" ADD COLUMN "supersedes_reply_id" text;--> statement-breakpoint
ALTER TABLE "anchor_replies" ADD COLUMN "version" integer;--> statement-breakpoint
ALTER TABLE "anchor_replies" DISABLE TRIGGER "anchor_replies_append_only";--> statement-breakpoint
WITH ranked_replies AS (
	SELECT
		"id",
		row_number() OVER (PARTITION BY "case_id" ORDER BY "submitted_at", "id")::integer AS "version",
		lag("id") OVER (PARTITION BY "case_id" ORDER BY "submitted_at", "id") AS "supersedes_reply_id"
	FROM "anchor_replies"
)
UPDATE "anchor_replies" AS reply
SET
	"version" = ranked."version",
	"supersedes_reply_id" = ranked."supersedes_reply_id"
FROM ranked_replies AS ranked
WHERE reply."id" = ranked."id";--> statement-breakpoint
ALTER TABLE "anchor_replies" ENABLE TRIGGER "anchor_replies_append_only";--> statement-breakpoint
ALTER TABLE "anchor_replies" ALTER COLUMN "version" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "anchor_replies" ALTER COLUMN "version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "anchor_claim_challenges" ADD CONSTRAINT "anchor_claim_challenges_anchor_id_anchors_id_fk" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_claim_challenges" ADD CONSTRAINT "anchor_claim_challenges_domain_id_anchor_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."anchor_domains"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_claim_sessions" ADD CONSTRAINT "anchor_claim_sessions_claimant_id_anchor_claimants_id_fk" FOREIGN KEY ("claimant_id") REFERENCES "public"."anchor_claimants"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_claimants" ADD CONSTRAINT "anchor_claimants_anchor_id_anchors_id_fk" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_claimants" ADD CONSTRAINT "anchor_claimants_domain_id_anchor_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."anchor_domains"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_disputes" ADD CONSTRAINT "anchor_disputes_flag_id_discrepancies_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."discrepancies"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_disputes" ADD CONSTRAINT "anchor_disputes_case_id_anchor_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."anchor_cases"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_disputes" ADD CONSTRAINT "anchor_disputes_claimant_id_anchor_claimants_id_fk" FOREIGN KEY ("claimant_id") REFERENCES "public"."anchor_claimants"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_evidence" ADD CONSTRAINT "anchor_evidence_reply_id_anchor_replies_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."anchor_replies"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_evidence" ADD CONSTRAINT "anchor_evidence_dispute_id_anchor_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."anchor_disputes"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "anchor_claim_challenges_token_hash_uidx" ON "anchor_claim_challenges" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "anchor_claim_challenges_anchor_expiry_idx" ON "anchor_claim_challenges" USING btree ("anchor_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "anchor_claim_sessions_token_hash_uidx" ON "anchor_claim_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "anchor_claim_sessions_claimant_expiry_idx" ON "anchor_claim_sessions" USING btree ("claimant_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "anchor_claimants_active_domain_uidx" ON "anchor_claimants" USING btree ("anchor_id","domain_id") WHERE "anchor_claimants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "anchor_claimants_anchor_idx" ON "anchor_claimants" USING btree ("anchor_id","verified_at");--> statement-breakpoint
CREATE INDEX "anchor_disputes_flag_submitted_idx" ON "anchor_disputes" USING btree ("flag_id","submitted_at");--> statement-breakpoint
CREATE INDEX "anchor_disputes_status_submitted_idx" ON "anchor_disputes" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "anchor_evidence_reply_idx" ON "anchor_evidence" USING btree ("reply_id");--> statement-breakpoint
CREATE INDEX "anchor_evidence_dispute_idx" ON "anchor_evidence" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "anchor_evidence_scan_idx" ON "anchor_evidence" USING btree ("scan_status","created_at");--> statement-breakpoint
ALTER TABLE "anchor_replies" ADD CONSTRAINT "anchor_replies_claimant_id_anchor_claimants_id_fk" FOREIGN KEY ("claimant_id") REFERENCES "public"."anchor_claimants"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_replies" ADD CONSTRAINT "anchor_replies_identity_case_unique" UNIQUE("id","case_id");--> statement-breakpoint
ALTER TABLE "anchor_replies" ADD CONSTRAINT "anchor_replies_supersedes_case_fk" FOREIGN KEY ("supersedes_reply_id","case_id") REFERENCES "public"."anchor_replies"("id","case_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "anchor_replies_case_version_uidx" ON "anchor_replies" USING btree ("case_id","version");--> statement-breakpoint
ALTER TABLE "anchor_replies" ADD CONSTRAINT "anchor_replies_version_check" CHECK ("anchor_replies"."version" > 0);--> statement-breakpoint
ALTER TABLE "anchor_replies" ADD CONSTRAINT "anchor_replies_version_link_check" CHECK (("anchor_replies"."version" = 1 AND "anchor_replies"."supersedes_reply_id" IS NULL) OR ("anchor_replies"."version" > 1 AND "anchor_replies"."supersedes_reply_id" IS NOT NULL));
--> statement-breakpoint
CREATE TRIGGER anchor_evidence_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.anchor_evidence
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.anchor_evidence FROM PUBLIC;--> statement-breakpoint
COMMENT ON TABLE public.anchor_evidence IS
  'ANC-04 immutable evidence metadata. Upload bytes are scanned before storage and are not stored in PostgreSQL.';
