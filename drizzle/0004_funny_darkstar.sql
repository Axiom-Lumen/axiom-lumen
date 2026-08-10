CREATE TYPE "public"."source_circuit_state" AS ENUM('closed', 'open');--> statement-breakpoint
CREATE TABLE "source_health_states" (
	"source_id" text PRIMARY KEY NOT NULL,
	"state" "source_health_state" NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"circuit_state" "source_circuit_state" DEFAULT 'closed' NOT NULL,
	"circuit_opened_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"last_observed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_health_states_failures_check" CHECK ("source_health_states"."consecutive_failures" >= 0),
	CONSTRAINT "source_health_states_circuit_check" CHECK (("source_health_states"."circuit_state" = 'closed' AND "source_health_states"."circuit_opened_at" IS NULL) OR
          ("source_health_states"."circuit_state" = 'open' AND "source_health_states"."circuit_opened_at" IS NOT NULL AND "source_health_states"."next_attempt_at" IS NOT NULL)),
	CONSTRAINT "source_health_states_healthy_check" CHECK ("source_health_states"."state" <> 'healthy' OR
          ("source_health_states"."consecutive_failures" = 0 AND "source_health_states"."circuit_state" = 'closed' AND
           "source_health_states"."next_attempt_at" IS NULL AND "source_health_states"."last_error_code" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "source_health_states" ADD CONSTRAINT "source_health_states_source_id_source_definitions_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_definitions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "source_health_states_state_idx" ON "source_health_states" USING btree ("state","last_observed_at");--> statement-breakpoint
CREATE INDEX "source_health_states_circuit_idx" ON "source_health_states" USING btree ("circuit_state","next_attempt_at");