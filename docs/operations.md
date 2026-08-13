# Telemetry and system status

OPS-01 uses the existing persisted ingestion evidence as its operational source of truth. The status projection
aggregates retrieval attempts, source-health state, completed snapshots, ingest cycles, leases, and open
discrepancies. It does not infer service health from one web process's memory.

## Operational endpoints

- `GET /api/health/live` reports process liveness without touching PostgreSQL.
- `GET /api/health/ready` performs a lightweight database/schema and threshold-configuration check. It remains ready when upstream data is
  degraded because the API can still serve explicit degraded or unavailable representations.
- `GET /api/metrics` exports aggregate Prometheus text metrics for retrieval latency/failures, snapshot
  freshness, cycle lag/failures, source health, and discrepancies.
- `/status` renders the public persisted projection without source identities, endpoint URLs, disabled-source
  state, or unpublished discrepancy counts. `/api/metrics` uses the same public-safe visibility boundary.

Health and metric responses are `no-store`. Deployments should scrape metrics internally even though the
current endpoint contains aggregate, public-safe values. Alert routing and paging ownership remain deployment
configuration; the application owns threshold evaluation and stable alert codes. The expensive persisted
projection is cached per process for `OPS_STATUS_CACHE_SECONDS`; readiness never executes that aggregation.

## Thresholds

The `OPS_*` variables in `.env.example` define warning and critical bounds. Snapshot freshness is normalized
against each metric's methodology limit, with a separate configured limit for latest-ledger diagnostics. Warnings mark the public projection
as `degraded`; a critical alert marks it as `outage`. Critical thresholds must be strictly greater than warning
thresholds and invalid configuration fails closed when status is evaluated.

Readiness deliberately indicates dependency availability rather than upstream data quality. A stale snapshot
or failing source raises an operational alert but does not cause every web replica to be removed from service.

## Logs and traces

Public API requests emit one JSON completion record with `request_id`, W3C `trace_id`/`span_id`, stable route ID,
status, and duration. A valid incoming `traceparent` continues its trace with a new server span and the response
returns the new `Traceparent` header. Worker cycle records use a deterministic trace ID derived from the durable
cycle ID and include the worker, cycle, metric, and applicable source IDs.

Telemetry recursively redacts authorization, cookies, API keys, credentials, passwords, secrets, and tokens.
HTTP and PostgreSQL URLs have user information and sensitive query parameters replaced before serialization.
Logs record error type/code rather than exception messages or stacks, preventing credential-bearing upstream
URLs from being copied into operational output.
