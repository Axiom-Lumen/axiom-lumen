# Ingestion worker

ING-01 runs collection and reconciliation outside the Next.js request lifecycle. ING-02 adds bounded per-source
retries, circuit breaking, payload and timeout limits, and durable source-health projections. The worker discovers
enabled sources from PostgreSQL, creates one deterministic cycle per metric, subject, methodology version, and
schedule boundary, and commits the complete evidence/snapshot batch atomically. Latest-ledger subjects are
networks; supply subjects are explicitly registered classic credit assets keyed as `network:CODE:ISSUER`.

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

Supply discovery is opt-in per source and asset. Register the asset, then enable its durable asset row ID in
each eligible Horizon/archive source's `config.supply.assetIds`. Archive sources must also carry the externally
verified checkpoint manifest consumed by the archive adapter:

```sql
INSERT INTO assets (id, network_id, type, code, issuer, canonical_id)
VALUES ('public-usdc', 'public', 'credit', 'USDC', '<issuer>', 'USDC:<issuer>');

UPDATE source_definitions
SET config = jsonb_set(config, '{supply}',
  '{"enabled":true,"assetIds":["public-usdc"]}'::jsonb)
WHERE id = 'stellar-public-horizon';

-- The independent verification pipeline must update the archive URL and
-- trustedCheckpoints.public-usdc together before the scheduled cycle.
```

Absent or disabled supply configuration is ignored during discovery. An enabled but malformed supply
configuration is retained in every otherwise eligible asset job and produces a structured configuration failure,
so an operator-visible source error cannot disappear through routing. A configured archive source without a valid
trusted checkpoint is likewise retained and cannot be silently treated as independent evidence.

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
- `SOURCE_RETRY_MAX_ATTEMPTS`: total attempts per source and cycle; defaults to `3`.
- `SOURCE_RETRY_BASE_DELAY_MS` / `SOURCE_RETRY_MAX_DELAY_MS`: exponential-backoff bounds; defaults to `250`
  and `5000`. The maximum must not be lower than the base.
- `SOURCE_RETRY_JITTER_RATIO`: symmetric jitter from `0` through `1`; defaults to `0.2`.
- `SOURCE_CONCURRENCY`: maximum sources collected concurrently within one job; defaults to `4`.
- `SOURCE_CIRCUIT_FAILURE_THRESHOLD`: consecutive transient failures before opening a source circuit; defaults
  to `3`.
- `SOURCE_CIRCUIT_COOLDOWN_MS`: minimum open-circuit cooldown; defaults to `60000`.
- `HORIZON_TIMEOUT_MS`: timeout applied to each Horizon request; defaults to `5000`.
- `HORIZON_MAX_RESPONSE_BYTES`: maximum decoded bytes accepted from each Horizon response; defaults to
  `1000000`.

Except for the bounded jitter ratio, every numeric setting must be a positive integer. Keep the lease duration
comfortably above the worst-case per-source retry duration. `WORKER_CONCURRENCY` limits jobs; the independent
`SOURCE_CONCURRENCY` limit bounds upstream fan-out inside each job.

Only transport failures, timeouts, HTTP 408/425/429, and server errors are retried. Validation failures,
network mismatches, redirect/policy rejection, malformed or oversized bodies, and permanent HTTP failures are
attempted once. Backoff is exponential with bounded jitter; a valid `Retry-After` value can extend the delay up
to the configured maximum.

The mutable `source_health_states` projection persists circuit state and the next permitted attempt across
worker restarts. Every finalized cycle also appends an immutable health sample. States are `healthy`,
`unreachable`, `rejected`, `malformed`, `stale`, or `network_mismatched`. An observation older than the
latest-ledger freshness half-life is retained as evidence with decayed reconciliation weight and recorded as
`stale` health. Supply evidence older than its hard 120-second maximum is also retained as a raw reading, but is
excluded from the current snapshot; if no current evidence remains, the snapshot is `unavailable` with a null
value. An open circuit skips network retrieval until its cooldown expires; unrelated sources continue
and can still produce a degraded snapshot.

## Lease and shutdown behavior

Claims use PostgreSQL row locks with `SKIP LOCKED`, an owner, and a monotonically increasing lease token. A
heartbeat extends ownership while a handler runs. Losing the lease or receiving a shutdown signal cancels the
connector and returns unfinished work to pending state.

Each new lease stores the fully validated discovered job definition—including source endpoints, network identity,
asset, and trusted checkpoint—plus its canonical SHA-256 digest. Claims verify that digest and execute the stored
definition, so registry edits after scheduling cannot change a retry's inputs. Nullable fields remain only for
leases created before this migration; those legacy leases use the current discovery result.

A partial unique index permits only one pending/running cycle for a metric and subject. This keeps stateful
discrepancy projection updates ordered for one network or asset while still allowing unrelated subjects to run in
parallel.

The finalized `ingest_cycles.idempotency_key` is the second fence. If a process crashes after committing a cycle
but before acknowledging its scheduler lease, the reaper detects the durable cycle and marks the lease complete.
If it crashes earlier, the expired lease returns to pending until its attempt budget is exhausted. Thus another
worker can resume from the last durable boundary without duplicating a finalized cycle.

When stale and replacement workers overlap, the deterministic scheduled identity selects one durable winner;
different execution timestamps do not turn the losing retry into an idempotency failure. Each immutable raw
reading also stores the complete source identity used for retrieval, so later source-registry edits cannot rewrite
historical API provenance.
