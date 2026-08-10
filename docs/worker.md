# Ingestion worker

ING-01 runs collection and reconciliation outside the Next.js request lifecycle. The worker discovers enabled
Horizon sources from PostgreSQL, creates one deterministic cycle per metric, network, methodology version, and
schedule boundary, and commits the complete evidence/snapshot batch atomically.

## Local setup

Start PostgreSQL and apply the committed migrations:

```bash
docker compose -f compose.database.yml up -d
DATABASE_MIGRATION_URL=postgresql://axiom:axiom@127.0.0.1:55432/axiom_lumen npm run db:migrate
```

Register the Public Network and at least one enabled Horizon source. Source IDs are durable provenance keys, so
do not rename or reuse them for a different endpoint:

```sql
INSERT INTO networks (id, passphrase, display_name)
VALUES ('public', 'Public Global Stellar Network ; September 2015', 'Stellar Public Network')
ON CONFLICT (id) DO NOTHING;

INSERT INTO source_definitions (id, network_id, source_class, adapter, url, upstream_id)
VALUES ('stellar-public-horizon', 'public', 'canonical_ledger', 'horizon',
        'https://horizon.stellar.org', 'stellar-public-horizon')
ON CONFLICT (network_id, url) DO NOTHING;
```

Run exactly one scheduling/drain pass:

```bash
npm run worker:once
```

Run continuously until `SIGINT` or `SIGTERM`:

```bash
npm run worker:continuous
```

After one finalized cycle, `npm run dev` serves the latest persisted Public Network snapshot from
`GET /api/v1/stellar/latest-ledger`. A web request never calls Horizon or waits for a collection cycle.

## Configuration

- `DATABASE_URL`: worker/web runtime PostgreSQL URL.
- `WORKER_ID`: lease owner label; defaults to `hostname:pid`.
- `INGEST_INTERVAL_SECONDS`: deterministic cycle bucket width; defaults to `60`.
- `WORKER_CONCURRENCY`: maximum jobs handled concurrently by one process; defaults to `4`.
- `WORKER_LEASE_DURATION_MS`: lease duration and heartbeat basis; defaults to `30000`.
- `WORKER_MAX_ATTEMPTS`: number of expired claims before abandonment; defaults to `3`.
- `WORKER_POLL_INTERVAL_MS`: delay between continuous scheduler passes; defaults to `5000`.
- `STELLAR_HORIZON_ALLOWED_HOSTS` / `STELLAR_HORIZON_DENIED_HOSTS`: optional hostname policy applied to
  database-discovered endpoints. Credentials and local/private literal hosts are always rejected.

Every numeric setting must be a positive integer. Keep the lease duration comfortably above normal connector
latency. ING-02 will add retry/backoff and circuit-breaker policy; ING-01 intentionally retries only work whose
lease expired before a durable finalization boundary.

## Lease and shutdown behavior

Claims use PostgreSQL row locks with `SKIP LOCKED`, an owner, and a monotonically increasing lease token. A
heartbeat extends ownership while a handler runs. Losing the lease or receiving a shutdown signal cancels the
connector and returns unfinished work to pending state.

A partial unique index permits only one pending/running cycle for a metric and subject. This keeps stateful
discrepancy projection updates ordered for one network while still allowing unrelated subjects to run in
parallel.

The finalized `ingest_cycles.idempotency_key` is the second fence. If a process crashes after committing a cycle
but before acknowledging its scheduler lease, the reaper detects the durable cycle and marks the lease complete.
If it crashes earlier, the expired lease returns to pending until its attempt budget is exhausted. Thus another
worker can resume from the last durable boundary without duplicating a finalized cycle.

When stale and replacement workers overlap, the deterministic scheduled identity selects one durable winner;
different execution timestamps do not turn the losing retry into an idempotency failure. Each immutable raw
reading also stores the complete source identity used for retrieval, so later source-registry edits cannot rewrite
historical API provenance.
