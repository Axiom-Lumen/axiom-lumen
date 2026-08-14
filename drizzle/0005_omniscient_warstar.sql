ALTER TABLE "scheduled_cycle_leases" ADD COLUMN "job_definition" jsonb;--> statement-breakpoint
ALTER TABLE "scheduled_cycle_leases" ADD COLUMN "job_definition_sha256" text;--> statement-breakpoint
ALTER TABLE "scheduled_cycle_leases" ADD CONSTRAINT "scheduled_cycle_leases_job_definition_check" CHECK (("scheduled_cycle_leases"."job_definition" IS NULL AND "scheduled_cycle_leases"."job_definition_sha256" IS NULL) OR
          ("scheduled_cycle_leases"."job_definition" IS NOT NULL AND "scheduled_cycle_leases"."job_definition_sha256" ~ '^[0-9a-f]{64}$'));