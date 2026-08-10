CREATE TABLE "scheduled_cycle_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"metric" "metric" NOT NULL,
	"subject_key" text NOT NULL,
	"methodology_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" "ingest_cycle_status" DEFAULT 'pending' NOT NULL,
	"lease_owner" text,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"finalized_cycle_id" text,
	"last_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_cycle_leases_counts_check" CHECK ("scheduled_cycle_leases"."lease_token" >= 0 AND "scheduled_cycle_leases"."attempt_count" >= 0),
	CONSTRAINT "scheduled_cycle_leases_ownership_check" CHECK (("scheduled_cycle_leases"."status" = 'running' AND "scheduled_cycle_leases"."lease_owner" IS NOT NULL AND
            "scheduled_cycle_leases"."lease_expires_at" IS NOT NULL AND "scheduled_cycle_leases"."heartbeat_at" IS NOT NULL) OR
          ("scheduled_cycle_leases"."status" <> 'running' AND "scheduled_cycle_leases"."lease_owner" IS NULL AND
            "scheduled_cycle_leases"."lease_expires_at" IS NULL AND "scheduled_cycle_leases"."heartbeat_at" IS NULL)),
	CONSTRAINT "scheduled_cycle_leases_finalization_check" CHECK (("scheduled_cycle_leases"."status" = 'completed' AND "scheduled_cycle_leases"."finalized_cycle_id" IS NOT NULL) OR
          ("scheduled_cycle_leases"."status" <> 'completed' AND "scheduled_cycle_leases"."finalized_cycle_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "raw_readings" ADD COLUMN "source_identity" jsonb;--> statement-breakpoint
ALTER TABLE "raw_readings" DISABLE TRIGGER "raw_readings_append_only";--> statement-breakpoint
UPDATE "raw_readings" AS "reading"
SET "source_identity" = jsonb_build_object(
	'id', "source"."id",
	'sourceClass', "source"."source_class",
	'adapter', "source"."adapter",
	'url', "source"."url",
	'network', jsonb_build_object('id', "network"."id", 'passphrase', "network"."passphrase")
)
FROM "source_definitions" AS "source"
INNER JOIN "networks" AS "network" ON "network"."id" = "source"."network_id"
WHERE "reading"."source_id" = "source"."id";--> statement-breakpoint
ALTER TABLE "raw_readings" ENABLE TRIGGER "raw_readings_append_only";--> statement-breakpoint
ALTER TABLE "raw_readings" ALTER COLUMN "source_identity" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_cycle_leases" ADD CONSTRAINT "scheduled_cycle_leases_finalized_cycle_id_ingest_cycles_id_fk" FOREIGN KEY ("finalized_cycle_id") REFERENCES "public"."ingest_cycles"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_cycle_leases_idempotency_uidx" ON "scheduled_cycle_leases" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_cycle_leases_finalized_cycle_uidx" ON "scheduled_cycle_leases" USING btree ("finalized_cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_cycle_leases_active_subject_uidx" ON "scheduled_cycle_leases" USING btree ("metric","subject_key") WHERE "scheduled_cycle_leases"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "scheduled_cycle_leases_pending_idx" ON "scheduled_cycle_leases" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "scheduled_cycle_leases_expiry_idx" ON "scheduled_cycle_leases" USING btree ("status","lease_expires_at");
