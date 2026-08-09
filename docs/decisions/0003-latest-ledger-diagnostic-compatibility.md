# ADR 0003: Latest-ledger diagnostic compatibility and network boundary

- Status: Accepted
- Date: 2026-08-09
- Roadmap item: LED-01

## Context

`GET /api/v1/stellar/latest-ledger` predates persisted reconciliation snapshots. It performs live Horizon
requests and returns a compact snake_case response with diagnostic observations and immediate per-reading
discrepancies. Replacing that shape with the shared v1 snapshot response would break existing consumers and
could imply that an on-demand result has persistence or audit guarantees that do not exist yet.

The old connector also inferred network identity from the first usable Horizon root. That made result identity
dependent on response order and allowed a misconfigured first endpoint to establish the wrong network.

## Decision

- Keep `latest-ledger-v0.2` as a named request-time diagnostic profile.
- Run its reconciliation exclusively through the shared REC-04 orchestrator, then validate and serialize the
  established latest-ledger response shape through `latestLedgerResponseSchema`.
- Do not describe this route as a persisted production snapshot. Persisted APIs will use the shared v1 snapshot
  serializer after the repository and ingestion work is implemented.
- Pin this route to the Stellar Public Network passphrase. A source with any other passphrase is excluded before
  its ledger endpoint is requested, so it cannot affect value or confidence.
- Treat configured Horizon URLs as security boundaries: reject credentials and local/private literal hosts,
  support explicit host allow/deny lists, disable redirects, cap JSON bodies, validate payload schemas, and
  reject duplicate source identities.
- Capture one injected retrieval timestamp per request cycle and reuse it for observations, errors, and the
  reconciliation clock.

## Compatibility policy

Existing field names, types, status codes, observations, and immediate discrepancy semantics remain stable.
Methodology changes require a new named profile version. Changing this diagnostic route to the persisted v1
snapshot contract requires an explicit API compatibility decision and versioned migration.

## Consequences

- Existing clients retain the v0.2 response while computation uses the shared primitives.
- Direct requests are reproducible when the same clock and connector inputs are injected.
- Public Network identity no longer depends on source ordering.
- Local/private Horizon endpoints are not supported by this public route; a future explicitly privileged ingest
  worker may define a separate network and endpoint policy.
