CREATE TYPE "public"."anchor_case_status" AS ENUM('draft', 'awaiting_reply', 'under_review', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."anchor_status" AS ENUM('candidate', 'verified', 'suspended', 'retired');--> statement-breakpoint
CREATE TYPE "public"."api_principal_status" AS ENUM('active', 'suspended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."asset_type" AS ENUM('native', 'credit');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_lifecycle" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_publication" AS ENUM('internal', 'pending_reply', 'approved_public', 'withheld');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."ingest_cycle_status" AS ENUM('pending', 'running', 'completed', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."metric" AS ENUM('latest_ledger', 'circulating_supply', 'order_book_depth', 'trustline_count', 'anchor_reserves');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."reply_review_state" AS ENUM('not_required', 'awaiting_reply', 'response_received', 'response_reviewed', 'window_expired');--> statement-breakpoint
CREATE TYPE "public"."retrieval_outcome" AS ENUM('success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."snapshot_status" AS ENUM('verified', 'degraded', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."source_adapter" AS ENUM('horizon', 'archive', 'sdex', 'anchor', 'oracle');--> statement-breakpoint
CREATE TYPE "public"."source_class" AS ENUM('canonical_ledger', 'archive', 'dex', 'anchor_self_reported', 'third_party_oracle');--> statement-breakpoint
CREATE TYPE "public"."source_health_state" AS ENUM('healthy', 'unreachable', 'rejected', 'malformed', 'stale', 'network_mismatched');--> statement-breakpoint
CREATE TABLE "anchor_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"anchor_id" text NOT NULL,
	"discrepancy_id" text,
	"status" "anchor_case_status" DEFAULT 'draft' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"reply_due_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anchor_cases_reply_due_check" CHECK ("anchor_cases"."reply_due_at" IS NULL OR "anchor_cases"."reply_due_at" >= "anchor_cases"."opened_at"),
	CONSTRAINT "anchor_cases_closed_check" CHECK ("anchor_cases"."closed_at" IS NULL OR "anchor_cases"."closed_at" >= "anchor_cases"."opened_at")
);
--> statement-breakpoint
CREATE TABLE "anchor_contact_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"anchor_id" text NOT NULL,
	"kind" text NOT NULL,
	"endpoint" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anchor_contact_endpoints_kind_not_blank" CHECK (length(btrim("anchor_contact_endpoints"."kind")) > 0),
	CONSTRAINT "anchor_contact_endpoints_endpoint_not_blank" CHECK (length(btrim("anchor_contact_endpoints"."endpoint")) > 0)
);
--> statement-breakpoint
CREATE TABLE "anchor_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"anchor_id" text NOT NULL,
	"domain" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verification_evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anchor_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"submitted_by" text NOT NULL,
	"body" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anchor_replies_body_not_blank" CHECK (length(btrim("anchor_replies"."body")) > 0)
);
--> statement-breakpoint
CREATE TABLE "anchor_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"reply_id" text,
	"reviewer_principal_id" text NOT NULL,
	"decision" text NOT NULL,
	"notes" text,
	"reviewed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anchor_reviews_decision_not_blank" CHECK (length(btrim("anchor_reviews"."decision")) > 0)
);
--> statement-breakpoint
CREATE TABLE "anchors" (
	"id" text PRIMARY KEY NOT NULL,
	"network_id" text NOT NULL,
	"name" text NOT NULL,
	"stellar_account" text,
	"status" "anchor_status" DEFAULT 'candidate' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_not_blank" CHECK (length(btrim("api_keys"."key_hash")) > 0),
	CONSTRAINT "api_keys_expiry_check" CHECK ("api_keys"."expires_at" IS NULL OR "api_keys"."expires_at" > "api_keys"."created_at")
);
--> statement-breakpoint
CREATE TABLE "api_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"requests_per_window" integer NOT NULL,
	"window_seconds" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_plans_quota_check" CHECK ("api_plans"."requests_per_window" > 0 AND "api_plans"."window_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "api_principal_scopes" (
	"principal_id" text NOT NULL,
	"scope_id" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_principal_scopes_pk" PRIMARY KEY("principal_id","scope_id")
);
--> statement-breakpoint
CREATE TABLE "api_principals" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "api_principal_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_quota_usage" (
	"principal_id" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"request_count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_quota_usage_pk" PRIMARY KEY("principal_id","window_started_at"),
	CONSTRAINT "api_quota_usage_count_check" CHECK ("api_quota_usage"."request_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "api_scopes" (
	"id" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"network_id" text NOT NULL,
	"type" "asset_type" NOT NULL,
	"code" text,
	"issuer" text,
	"canonical_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_type_fields_check" CHECK (("assets"."type" = 'native' AND "assets"."code" IS NULL AND "assets"."issuer" IS NULL) OR
          ("assets"."type" = 'credit' AND "assets"."code" IS NOT NULL AND "assets"."issuer" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"target_event_id" text NOT NULL,
	"author_principal_id" text NOT NULL,
	"reason" text NOT NULL,
	"replacement" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corrections_reason_not_blank" CHECK (length(btrim("corrections"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "discrepancies" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"metric" "metric" NOT NULL,
	"subject_key" text NOT NULL,
	"methodology_version" text NOT NULL,
	"named_party" boolean DEFAULT false NOT NULL,
	"severity" "discrepancy_severity" NOT NULL,
	"lifecycle_state" "discrepancy_lifecycle" NOT NULL,
	"publication_state" "discrepancy_publication" NOT NULL,
	"reply_review_state" "reply_review_state" NOT NULL,
	"consecutive_cycles" integer NOT NULL,
	"consecutive_above_info_cycles" integer NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"last_finalized_cycle_id" text NOT NULL,
	"last_finalized_cycle_at" timestamp with time zone NOT NULL,
	"publication_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discrepancies_streaks_check" CHECK ("discrepancies"."consecutive_cycles" >= 0 AND "discrepancies"."consecutive_above_info_cycles" BETWEEN 0 AND "discrepancies"."consecutive_cycles"),
	CONSTRAINT "discrepancies_lifecycle_streak_check" CHECK (("discrepancies"."lifecycle_state" = 'open' AND "discrepancies"."consecutive_cycles" > 0) OR
          ("discrepancies"."lifecycle_state" = 'resolved' AND "discrepancies"."consecutive_cycles" = 0 AND "discrepancies"."consecutive_above_info_cycles" = 0)),
	CONSTRAINT "discrepancies_time_order_check" CHECK ("discrepancies"."last_observed_at" >= "discrepancies"."first_observed_at" AND
          "discrepancies"."last_finalized_cycle_at" >= "discrepancies"."last_observed_at" AND
          "discrepancies"."publication_updated_at" >= "discrepancies"."first_observed_at"),
	CONSTRAINT "discrepancies_publication_check" CHECK (("discrepancies"."severity" <> 'info' OR "discrepancies"."publication_state" = 'internal') AND
          NOT ("discrepancies"."named_party" AND "discrepancies"."severity" <> 'info' AND "discrepancies"."publication_state" = 'internal') AND
          ("discrepancies"."publication_state" <> 'pending_reply' OR
            ("discrepancies"."named_party" AND "discrepancies"."reply_review_state" <> 'not_required')))
);
--> statement-breakpoint
CREATE TABLE "discrepancy_events" (
	"id" text PRIMARY KEY NOT NULL,
	"discrepancy_id" text NOT NULL,
	"cycle_id" text,
	"target_event_id" text,
	"event_type" text NOT NULL,
	"methodology_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discrepancy_events_type_not_blank" CHECK (length(btrim("discrepancy_events"."event_type")) > 0)
);
--> statement-breakpoint
CREATE TABLE "ingest_cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"metric" "metric" NOT NULL,
	"subject_key" text NOT NULL,
	"methodology_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "ingest_cycle_status" DEFAULT 'pending' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_cycles_time_order_check" CHECK (("ingest_cycles"."started_at" IS NULL OR "ingest_cycles"."started_at" >= "ingest_cycles"."scheduled_at") AND
          ("ingest_cycles"."completed_at" IS NULL OR ("ingest_cycles"."started_at" IS NOT NULL AND "ingest_cycles"."completed_at" >= "ingest_cycles"."started_at"))),
	CONSTRAINT "ingest_cycles_terminal_state_check" CHECK (("ingest_cycles"."status" IN ('completed', 'failed', 'abandoned') AND "ingest_cycles"."completed_at" IS NOT NULL) OR
          ("ingest_cycles"."status" IN ('pending', 'running') AND "ingest_cycles"."completed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "networks" (
	"id" text PRIMARY KEY NOT NULL,
	"passphrase" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "networks_id_not_blank" CHECK (length(btrim("networks"."id")) > 0),
	CONSTRAINT "networks_passphrase_not_blank" CHECK (length(btrim("networks"."passphrase")) > 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"contact_endpoint_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_attempt_count_check" CHECK ("notifications"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "raw_readings" (
	"id" text PRIMARY KEY NOT NULL,
	"observation_id" text NOT NULL,
	"cycle_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"source_id" text NOT NULL,
	"metric" "metric" NOT NULL,
	"subject_key" text NOT NULL,
	"normalized_value" jsonb NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"source_timestamp" timestamp with time zone,
	"retrieved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_readings_identity_source_unique" UNIQUE("id","source_id"),
	CONSTRAINT "raw_readings_payload_sha256_check" CHECK ("raw_readings"."payload_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "reconciliation_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"cycle_id" text NOT NULL,
	"metric" "metric" NOT NULL,
	"subject_key" text NOT NULL,
	"status" "snapshot_status" NOT NULL,
	"subject" jsonb NOT NULL,
	"value" jsonb,
	"confidence" numeric(10, 9) NOT NULL,
	"confidence_formula_version" text NOT NULL,
	"confidence_components" jsonb NOT NULL,
	"confidence_caps_applied" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources_configured" integer NOT NULL,
	"sources_responded" integer NOT NULL,
	"sources_usable" integer NOT NULL,
	"sources_agreeing" integer NOT NULL,
	"sources_excluded" integer NOT NULL,
	"methodology_version" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_snapshots_confidence_check" CHECK ("reconciliation_snapshots"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "reconciliation_snapshots_value_check" CHECK (("reconciliation_snapshots"."status" = 'unavailable' AND "reconciliation_snapshots"."value" IS NULL) OR
          ("reconciliation_snapshots"."status" <> 'unavailable' AND "reconciliation_snapshots"."value" IS NOT NULL)),
	CONSTRAINT "reconciliation_snapshots_counts_check" CHECK ("reconciliation_snapshots"."sources_configured" >= 0 AND "reconciliation_snapshots"."sources_responded" BETWEEN 0 AND "reconciliation_snapshots"."sources_configured" AND
          "reconciliation_snapshots"."sources_usable" BETWEEN 0 AND "reconciliation_snapshots"."sources_responded" AND
          "reconciliation_snapshots"."sources_agreeing" BETWEEN 0 AND "reconciliation_snapshots"."sources_usable" AND
          "reconciliation_snapshots"."sources_excluded" BETWEEN 0 AND "reconciliation_snapshots"."sources_configured")
);
--> statement-breakpoint
CREATE TABLE "retrieval_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"cycle_id" text NOT NULL,
	"source_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"outcome" "retrieval_outcome" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"http_status" integer,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retrieval_attempts_identity_context_unique" UNIQUE("id","cycle_id","source_id"),
	CONSTRAINT "retrieval_attempts_number_check" CHECK ("retrieval_attempts"."attempt_number" > 0),
	CONSTRAINT "retrieval_attempts_time_order_check" CHECK ("retrieval_attempts"."completed_at" >= "retrieval_attempts"."started_at"),
	CONSTRAINT "retrieval_attempts_outcome_error_check" CHECK (("retrieval_attempts"."outcome" = 'success' AND "retrieval_attempts"."error" IS NULL) OR
          ("retrieval_attempts"."outcome" = 'failure' AND "retrieval_attempts"."error" IS NOT NULL)),
	CONSTRAINT "retrieval_attempts_http_status_check" CHECK ("retrieval_attempts"."http_status" IS NULL OR "retrieval_attempts"."http_status" BETWEEN 100 AND 599)
);
--> statement-breakpoint
CREATE TABLE "snapshot_contributions" (
	"snapshot_id" text NOT NULL,
	"reading_id" text NOT NULL,
	"source_id" text NOT NULL,
	"age_seconds" numeric(20, 6) NOT NULL,
	"effective_weight" numeric(20, 12) NOT NULL,
	"agrees" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshot_contributions_pk" PRIMARY KEY("snapshot_id","reading_id"),
	CONSTRAINT "snapshot_contributions_age_check" CHECK ("snapshot_contributions"."age_seconds" >= 0),
	CONSTRAINT "snapshot_contributions_weight_check" CHECK ("snapshot_contributions"."effective_weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "source_credential_references" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"provider" text NOT NULL,
	"secret_reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "source_credential_refs_secret_not_blank" CHECK (length(btrim("source_credential_references"."secret_reference")) > 0)
);
--> statement-breakpoint
CREATE TABLE "source_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"network_id" text NOT NULL,
	"anchor_id" text,
	"source_class" "source_class" NOT NULL,
	"adapter" "source_adapter" NOT NULL,
	"url" text NOT NULL,
	"upstream_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_definitions_url_not_blank" CHECK (length(btrim("source_definitions"."url")) > 0)
);
--> statement-breakpoint
CREATE TABLE "source_health_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"cycle_id" text NOT NULL,
	"source_id" text NOT NULL,
	"state" "source_health_state" NOT NULL,
	"latency_ms" integer,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_health_samples_latency_check" CHECK ("source_health_samples"."latency_ms" IS NULL OR "source_health_samples"."latency_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "anchor_cases" ADD CONSTRAINT "anchor_cases_anchor_id_anchors_id_fk" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_cases" ADD CONSTRAINT "anchor_cases_discrepancy_id_discrepancies_id_fk" FOREIGN KEY ("discrepancy_id") REFERENCES "public"."discrepancies"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_contact_endpoints" ADD CONSTRAINT "anchor_contact_endpoints_anchor_id_anchors_id_fk" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_domains" ADD CONSTRAINT "anchor_domains_anchor_id_anchors_id_fk" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_replies" ADD CONSTRAINT "anchor_replies_case_id_anchor_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."anchor_cases"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_reviews" ADD CONSTRAINT "anchor_reviews_case_id_anchor_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."anchor_cases"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_reviews" ADD CONSTRAINT "anchor_reviews_reply_id_anchor_replies_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."anchor_replies"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchor_reviews" ADD CONSTRAINT "anchor_reviews_reviewer_principal_id_api_principals_id_fk" FOREIGN KEY ("reviewer_principal_id") REFERENCES "public"."api_principals"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anchors" ADD CONSTRAINT "anchors_network_id_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."networks"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_principal_id_api_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."api_principals"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "api_principal_scopes" ADD CONSTRAINT "api_principal_scopes_principal_id_api_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."api_principals"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "api_principal_scopes" ADD CONSTRAINT "api_principal_scopes_scope_id_api_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."api_scopes"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "api_principals" ADD CONSTRAINT "api_principals_plan_id_api_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."api_plans"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "api_quota_usage" ADD CONSTRAINT "api_quota_usage_principal_id_api_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."api_principals"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_network_id_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."networks"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_case_id_anchor_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."anchor_cases"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_target_event_id_discrepancy_events_id_fk" FOREIGN KEY ("target_event_id") REFERENCES "public"."discrepancy_events"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_author_principal_id_api_principals_id_fk" FOREIGN KEY ("author_principal_id") REFERENCES "public"."api_principals"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_source_id_source_definitions_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_definitions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_last_finalized_cycle_id_ingest_cycles_id_fk" FOREIGN KEY ("last_finalized_cycle_id") REFERENCES "public"."ingest_cycles"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "discrepancy_events" ADD CONSTRAINT "discrepancy_events_discrepancy_id_discrepancies_id_fk" FOREIGN KEY ("discrepancy_id") REFERENCES "public"."discrepancies"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "discrepancy_events" ADD CONSTRAINT "discrepancy_events_cycle_id_ingest_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."ingest_cycles"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "discrepancy_events" ADD CONSTRAINT "discrepancy_events_target_event_fk" FOREIGN KEY ("target_event_id") REFERENCES "public"."discrepancy_events"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_case_id_anchor_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."anchor_cases"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_contact_endpoint_id_anchor_contact_endpoints_id_fk" FOREIGN KEY ("contact_endpoint_id") REFERENCES "public"."anchor_contact_endpoints"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "raw_readings" ADD CONSTRAINT "raw_readings_cycle_id_ingest_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."ingest_cycles"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "raw_readings" ADD CONSTRAINT "raw_readings_attempt_id_retrieval_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."retrieval_attempts"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "raw_readings" ADD CONSTRAINT "raw_readings_source_id_source_definitions_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_definitions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "raw_readings" ADD CONSTRAINT "raw_readings_attempt_context_fk" FOREIGN KEY ("attempt_id","cycle_id","source_id") REFERENCES "public"."retrieval_attempts"("id","cycle_id","source_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "reconciliation_snapshots" ADD CONSTRAINT "reconciliation_snapshots_cycle_id_ingest_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."ingest_cycles"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "retrieval_attempts" ADD CONSTRAINT "retrieval_attempts_cycle_id_ingest_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."ingest_cycles"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "retrieval_attempts" ADD CONSTRAINT "retrieval_attempts_source_id_source_definitions_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_definitions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "snapshot_contributions" ADD CONSTRAINT "snapshot_contributions_snapshot_id_reconciliation_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."reconciliation_snapshots"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "snapshot_contributions" ADD CONSTRAINT "snapshot_contributions_reading_id_raw_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."raw_readings"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "snapshot_contributions" ADD CONSTRAINT "snapshot_contributions_source_id_source_definitions_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_definitions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "snapshot_contributions" ADD CONSTRAINT "snapshot_contributions_reading_source_fk" FOREIGN KEY ("reading_id","source_id") REFERENCES "public"."raw_readings"("id","source_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "source_credential_references" ADD CONSTRAINT "source_credential_references_source_id_source_definitions_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_definitions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "source_definitions" ADD CONSTRAINT "source_definitions_network_id_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."networks"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "source_definitions" ADD CONSTRAINT "source_definitions_anchor_id_anchors_id_fk" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "source_health_samples" ADD CONSTRAINT "source_health_samples_cycle_id_ingest_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."ingest_cycles"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "source_health_samples" ADD CONSTRAINT "source_health_samples_source_id_source_definitions_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_definitions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "anchor_cases_discrepancy_uidx" ON "anchor_cases" USING btree ("discrepancy_id");--> statement-breakpoint
CREATE INDEX "anchor_cases_anchor_status_idx" ON "anchor_cases" USING btree ("anchor_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "anchor_contact_endpoints_anchor_kind_endpoint_uidx" ON "anchor_contact_endpoints" USING btree ("anchor_id","kind","endpoint");--> statement-breakpoint
CREATE UNIQUE INDEX "anchor_domains_domain_uidx" ON "anchor_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "anchor_domains_anchor_idx" ON "anchor_domains" USING btree ("anchor_id");--> statement-breakpoint
CREATE INDEX "anchor_replies_case_submitted_idx" ON "anchor_replies" USING btree ("case_id","submitted_at");--> statement-breakpoint
CREATE INDEX "anchor_reviews_case_reviewed_idx" ON "anchor_reviews" USING btree ("case_id","reviewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "anchors_network_name_uidx" ON "anchors" USING btree ("network_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "anchors_network_account_uidx" ON "anchors" USING btree ("network_id","stellar_account");--> statement-breakpoint
CREATE INDEX "anchors_status_idx" ON "anchors" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_uidx" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uidx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_principal_idx" ON "api_keys" USING btree ("principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_plans_name_uidx" ON "api_plans" USING btree ("name");--> statement-breakpoint
CREATE INDEX "api_principals_plan_status_idx" ON "api_principals" USING btree ("plan_id","status");--> statement-breakpoint
CREATE INDEX "api_quota_usage_window_idx" ON "api_quota_usage" USING btree ("window_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_network_canonical_uidx" ON "assets" USING btree ("network_id","canonical_id");--> statement-breakpoint
CREATE INDEX "assets_issuer_idx" ON "assets" USING btree ("issuer");--> statement-breakpoint
CREATE INDEX "corrections_target_event_idx" ON "corrections" USING btree ("target_event_id");--> statement-breakpoint
CREATE INDEX "corrections_case_idx" ON "corrections" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discrepancies_open_source_subject_uidx" ON "discrepancies" USING btree ("source_id","metric","subject_key") WHERE "discrepancies"."lifecycle_state" = 'open';--> statement-breakpoint
CREATE INDEX "discrepancies_subject_state_idx" ON "discrepancies" USING btree ("metric","subject_key","lifecycle_state");--> statement-breakpoint
CREATE INDEX "discrepancies_publication_idx" ON "discrepancies" USING btree ("publication_state","publication_updated_at");--> statement-breakpoint
CREATE INDEX "discrepancy_events_discrepancy_occurred_idx" ON "discrepancy_events" USING btree ("discrepancy_id","occurred_at");--> statement-breakpoint
CREATE INDEX "discrepancy_events_cycle_idx" ON "discrepancy_events" USING btree ("cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discrepancy_events_target_type_uidx" ON "discrepancy_events" USING btree ("target_event_id","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_cycles_idempotency_uidx" ON "ingest_cycles" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "ingest_cycles_metric_subject_completed_idx" ON "ingest_cycles" USING btree ("metric","subject_key","completed_at");--> statement-breakpoint
CREATE INDEX "ingest_cycles_status_scheduled_idx" ON "ingest_cycles" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "networks_passphrase_uidx" ON "networks" USING btree ("passphrase");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_idempotency_uidx" ON "notifications" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "notifications_status_next_attempt_idx" ON "notifications" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notifications_case_idx" ON "notifications" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_readings_observation_uidx" ON "raw_readings" USING btree ("observation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_readings_cycle_source_uidx" ON "raw_readings" USING btree ("cycle_id","source_id");--> statement-breakpoint
CREATE INDEX "raw_readings_metric_subject_retrieved_idx" ON "raw_readings" USING btree ("metric","subject_key","retrieved_at");--> statement-breakpoint
CREATE INDEX "raw_readings_attempt_idx" ON "raw_readings" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_snapshots_cycle_uidx" ON "reconciliation_snapshots" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "reconciliation_snapshots_latest_idx" ON "reconciliation_snapshots" USING btree ("metric","subject_key","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "retrieval_attempts_cycle_source_number_uidx" ON "retrieval_attempts" USING btree ("cycle_id","source_id","attempt_number");--> statement-breakpoint
CREATE INDEX "retrieval_attempts_source_completed_idx" ON "retrieval_attempts" USING btree ("source_id","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_contributions_snapshot_source_uidx" ON "snapshot_contributions" USING btree ("snapshot_id","source_id");--> statement-breakpoint
CREATE INDEX "snapshot_contributions_source_idx" ON "snapshot_contributions" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_credential_refs_source_provider_uidx" ON "source_credential_references" USING btree ("source_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "source_definitions_network_url_uidx" ON "source_definitions" USING btree ("network_id","url");--> statement-breakpoint
CREATE INDEX "source_definitions_enabled_class_idx" ON "source_definitions" USING btree ("enabled","source_class");--> statement-breakpoint
CREATE INDEX "source_definitions_anchor_idx" ON "source_definitions" USING btree ("anchor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_health_samples_cycle_source_uidx" ON "source_health_samples" USING btree ("cycle_id","source_id");--> statement-breakpoint
CREATE INDEX "source_health_samples_source_observed_idx" ON "source_health_samples" USING btree ("source_id","observed_at");