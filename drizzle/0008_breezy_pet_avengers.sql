CREATE TYPE "public"."notification_delivery_outcome" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TABLE "anchor_case_events" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anchor_case_events_type_not_blank" CHECK (length(btrim("anchor_case_events"."event_type")) > 0),
	CONSTRAINT "anchor_case_events_actor_check" CHECK ("anchor_case_events"."actor_type" IN ('system', 'anchor', 'reviewer')),
	CONSTRAINT "anchor_case_events_actor_id_check" CHECK (("anchor_case_events"."actor_type" = 'system' AND "anchor_case_events"."actor_id" IS NULL) OR
          ("anchor_case_events"."actor_type" <> 'system' AND length(btrim("anchor_case_events"."actor_id")) > 0))
);
--> statement-breakpoint
CREATE TABLE "notification_delivery_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"notification_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"outcome" "notification_delivery_outcome" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"http_status" integer,
	"failure" jsonb,
	"response_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_delivery_attempts_number_check" CHECK ("notification_delivery_attempts"."attempt_number" > 0),
	CONSTRAINT "notification_delivery_attempts_time_check" CHECK ("notification_delivery_attempts"."completed_at" >= "notification_delivery_attempts"."started_at"),
	CONSTRAINT "notification_delivery_attempts_http_check" CHECK ("notification_delivery_attempts"."http_status" IS NULL OR "notification_delivery_attempts"."http_status" BETWEEN 100 AND 599),
	CONSTRAINT "notification_delivery_attempts_response_hash_check" CHECK ("notification_delivery_attempts"."response_sha256" IS NULL OR "notification_delivery_attempts"."response_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "notification_delivery_attempts_outcome_check" CHECK (("notification_delivery_attempts"."outcome" = 'sent' AND "notification_delivery_attempts"."failure" IS NULL) OR
          ("notification_delivery_attempts"."outcome" = 'failed' AND "notification_delivery_attempts"."failure" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "discrepancies" DROP CONSTRAINT "discrepancies_publication_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "payload_sha256" text;--> statement-breakpoint
UPDATE "notifications" AS notification
SET "channel" = CASE WHEN contact."kind" = 'webhook' THEN 'webhook' ELSE 'email' END,
    "payload" = '{}'::jsonb,
    "payload_sha256" = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
FROM "anchor_contact_endpoints" AS contact
WHERE notification."contact_endpoint_id" = contact."id";--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "channel" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "payload" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "payload_sha256" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "anchor_case_events" ADD CONSTRAINT "anchor_case_events_case_id_anchor_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."anchor_cases"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "anchor_case_events_case_occurred_idx" ON "anchor_case_events" USING btree ("case_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_attempts_number_uidx" ON "notification_delivery_attempts" USING btree ("notification_id","attempt_number");--> statement-breakpoint
CREATE INDEX "notification_delivery_attempts_notification_idx" ON "notification_delivery_attempts" USING btree ("notification_id","completed_at");--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_publication_check" CHECK (("discrepancies"."severity" <> 'info' OR "discrepancies"."publication_state" = 'internal') AND
          ("discrepancies"."publication_state" <> 'pending_reply' OR
            ("discrepancies"."named_party" AND "discrepancies"."reply_review_state" <> 'not_required')));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_channel_check" CHECK ("notifications"."channel" IN ('email', 'webhook'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_payload_sha256_check" CHECK ("notifications"."payload_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE TRIGGER anchor_case_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.anchor_case_events
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER notification_delivery_attempts_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.notification_delivery_attempts
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  public.anchor_case_events,
  public.notification_delivery_attempts
FROM PUBLIC;--> statement-breakpoint
COMMENT ON TABLE public.anchor_case_events IS
  'ANC-03 immutable case lifecycle audit; current anchor_cases rows are projections.';--> statement-breakpoint
COMMENT ON TABLE public.notification_delivery_attempts IS
  'ANC-03 immutable delivery audit; response bodies and endpoint secrets are not stored.';
