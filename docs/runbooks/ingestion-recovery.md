# Upstream outage and stuck worker

## Upstream outage

Confirm the failing source IDs and error codes in aggregate telemetry, then check source health outside the
application from an approved network. Do not weaken passphrase, SSRF, TLS, freshness, or confidence checks to make
the source appear healthy. Disable only the affected source definition when it is returning unsafe data; retain
other independent sources. Public responses must remain explicitly degraded, stale, or unavailable. Re-enable a
source only after successful bounded probes and two normal ingestion cycles. Backfill through ordinary idempotent
jobs and compare the resulting snapshot before closing.

Use a reviewed transaction with a migration-capable operator connection to toggle only the resolved source ID:

```sql
BEGIN;
UPDATE source_definitions SET enabled = false WHERE id = :'source_id' AND enabled RETURNING id, enabled;
COMMIT;
```

Record the returned ID and operator in the incident timeline. Use the same guarded statement with `enabled = true`
only after validation. Never change endpoint identity, evidence, or health history during containment.

## Stuck worker or lease

Identify the lease, worker, cycle trace ID, heartbeat, attempt count, and scheduled age. If the owner process is
alive, inspect resource saturation and upstream timeouts before restarting it. The scheduler reaps expired leases;
never update lease rows manually. Stop the affected worker gracefully, wait beyond the lease duration, and let a
healthy worker reclaim it. If attempts are exhausted, preserve the abandoned lease; after fixing the cause, the
ordinary scheduler creates the next time-bucketed idempotent lease. There is no manual lease requeue. Confirm
exactly one durable finalization, normal lag, and no duplicate snapshot/event.
