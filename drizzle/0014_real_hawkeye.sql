CREATE TYPE "public"."api_key_event_type" AS ENUM('created', 'rotated', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."api_quota_kind" AS ENUM('sustained', 'burst');--> statement-breakpoint
CREATE TABLE "api_key_events" (
	"id" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"event_type" "api_key_event_type" NOT NULL,
	"actor" text NOT NULL,
	"related_key_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_key_events_actor_not_blank" CHECK (length(btrim("api_key_events"."actor")) > 0),
	CONSTRAINT "api_key_events_rotation_relation_check" CHECK (("api_key_events"."event_type" = 'rotated') = ("api_key_events"."related_key_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "api_plan_route_limits" (
	"plan_id" text NOT NULL,
	"route_id" text NOT NULL,
	"requests_per_window" integer NOT NULL,
	"window_seconds" integer NOT NULL,
	"burst_requests" integer NOT NULL,
	"burst_window_seconds" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_plan_route_limits_pk" PRIMARY KEY("plan_id","route_id"),
	CONSTRAINT "api_plan_route_limits_route_not_blank" CHECK (length(btrim("api_plan_route_limits"."route_id")) > 0),
	CONSTRAINT "api_plan_route_limits_quota_check" CHECK ("api_plan_route_limits"."requests_per_window" > 0 AND "api_plan_route_limits"."window_seconds" > 0 AND "api_plan_route_limits"."burst_requests" > 0 AND "api_plan_route_limits"."burst_window_seconds" > 0 AND "api_plan_route_limits"."burst_window_seconds" <= "api_plan_route_limits"."window_seconds")
);
--> statement-breakpoint
ALTER TABLE "api_quota_usage" ADD COLUMN "route_id" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_quota_usage" ADD COLUMN "quota_kind" "api_quota_kind" DEFAULT 'sustained' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key_events" ADD CONSTRAINT "api_key_events_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "api_key_events" ADD CONSTRAINT "api_key_events_principal_id_api_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."api_principals"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "api_key_events" ADD CONSTRAINT "api_key_events_related_key_id_api_keys_id_fk" FOREIGN KEY ("related_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "api_plan_route_limits" ADD CONSTRAINT "api_plan_route_limits_plan_id_api_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."api_plans"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "api_key_events_key_occurred_idx" ON "api_key_events" USING btree ("key_id","occurred_at");--> statement-breakpoint
CREATE INDEX "api_key_events_principal_occurred_idx" ON "api_key_events" USING btree ("principal_id","occurred_at");--> statement-breakpoint
CREATE INDEX "api_plan_route_limits_route_idx" ON "api_plan_route_limits" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "api_quota_usage_route_window_idx" ON "api_quota_usage" USING btree ("route_id","window_started_at");--> statement-breakpoint
ALTER TABLE "api_quota_usage" DROP CONSTRAINT "api_quota_usage_pk";
--> statement-breakpoint
ALTER TABLE "api_quota_usage" ADD CONSTRAINT "api_quota_usage_pk" PRIMARY KEY("principal_id","route_id","quota_kind","window_started_at");--> statement-breakpoint
ALTER TABLE "api_quota_usage" ADD CONSTRAINT "api_quota_usage_route_not_blank" CHECK (length(btrim("api_quota_usage"."route_id")) > 0);--> statement-breakpoint
ALTER TABLE "api_quota_usage" ALTER COLUMN "route_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "api_quota_usage" ALTER COLUMN "quota_kind" DROP DEFAULT;--> statement-breakpoint
CREATE TRIGGER api_key_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.api_key_events
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.api_key_events FROM PUBLIC;--> statement-breakpoint
COMMENT ON TABLE public.api_key_events IS
  'SEC-01 append-only audit history for API key creation, rotation, and revocation.';
