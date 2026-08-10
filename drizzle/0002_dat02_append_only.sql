CREATE OR REPLACE FUNCTION public.reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; append a superseding event instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER retrieval_attempts_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.retrieval_attempts
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER raw_readings_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.raw_readings
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER source_health_samples_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.source_health_samples
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER reconciliation_snapshots_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.reconciliation_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER snapshot_contributions_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.snapshot_contributions
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER discrepancy_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.discrepancy_events
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER anchor_replies_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.anchor_replies
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER anchor_reviews_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.anchor_reviews
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER corrections_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.corrections
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  public.retrieval_attempts,
  public.raw_readings,
  public.source_health_samples,
  public.reconciliation_snapshots,
  public.snapshot_contributions,
  public.discrepancy_events,
  public.anchor_replies,
  public.anchor_reviews,
  public.corrections
FROM PUBLIC;

COMMENT ON FUNCTION public.reject_append_only_mutation() IS
  'DAT-02 invariant: immutable evidence and audit rows are superseded only by new records.';
