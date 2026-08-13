CREATE TABLE "snapshot_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "snapshot_events" ADD CONSTRAINT "snapshot_events_snapshot_id_reconciliation_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."reconciliation_snapshots"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_events_snapshot_uidx" ON "snapshot_events" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "snapshot_events_occurred_idx" ON "snapshot_events" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE TRIGGER snapshot_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.snapshot_events
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.snapshot_events FROM PUBLIC;--> statement-breakpoint
COMMENT ON TABLE public.snapshot_events IS
  'EVT-01 durable append-only public snapshot event log for SSE replay and resume.';
