# Domain and API contracts v1

This document describes the shared runtime contracts introduced by roadmap item MTH-04. The executable
schemas in `lib/contracts/` are authoritative; this document explains their boundaries and conventions.

## Boundary rule

All data entering from HTTP, connector payloads, configuration, persistence, or fixtures must be parsed by a
runtime schema. Type assertions do not validate untrusted data. Schemas reject unknown object keys so new or
misspelled fields cannot silently enter reconciliation.

## Domain conventions

- Domain objects use `camelCase`.
- Public API objects use `snake_case` and are produced only by `lib/contracts/api.ts`.
- Timestamps accept ISO 8601 offsets at ingestion and normalize to UTC with millisecond precision.
- Stellar amounts become `StellarAmount` instances internally and serialize as canonical decimal strings.
- Large counts become `bigint` internally and serialize as base-10 strings.
- Source identity includes source class, adapter, URL, and Stellar network identity.
- Transport and validation failures use `SourceError`; they are not discrepancies.
- Observations are discriminated by metric so a supply amount cannot be consumed as a ledger sequence.

The internal supply discriminator remains `circulating_supply` for domain/database compatibility. Public v1
serialization maps it to `onchain_asset_supply`, the scope-accurate ID approved by ADR 0005. The canonical
future endpoint is `/api/v1/supply/{asset}` and supports classic credit assets only under
`onchain-asset-supply-v0.1`; native XLM requires a separate profile.

Supply observations additionally require the closed ledger, all six exact component amounts, methodology
version, evidence digest, connector/software versions, and a typed derivation checkpoint. Archive checkpoints
also retain the independently trusted artifact digest and manifest identity, source, verification method,
verification-proof digest, and verification time. Horizon aggregates and history-archive state replays use
distinct derivation families bound to their permitted source identity; changing only a Horizon hostname does not
create independent evidence.

Order-book depth observations use the canonical pair orientation defined by
`order-book-depth-v0.1`, one of its configured 50, 100, or 500 basis-point bands, a bid/ask side, an exact
base-asset-equivalent amount, and the rational two-sided midpoint used as the reference price. They also retain
the closed ledger, methodology and connector versions, evidence digest, and a typed Horizon SDEX offer-scan
checkpoint. The runtime schema requires a `dex` / `sdex` source identity, a non-null closed-ledger timestamp,
canonical asset order, and a checkpoint ledger equal to the observation ledger.

The depth connector reports `invalid_pair`, `crossed_book`, and `stale_book` through the shared source-error
vocabulary in addition to the existing configuration, transport, HTTP, payload, network, pagination, and
ledger-drift failures. The persisted worker reports empty and one-sided states as `empty_book` and
`one_sided_book`. The public depth value is one coherent six-bucket book with its exact midpoint and ledger/time
boundary; `GET /api/v1/depth/{pair}` serves finalized `order-book-depth-v0.2` snapshots only.

Supply reconciliation persists the same immutable cycle boundary as latest-ledger reconciliation. Its durable
subject key is `network:CODE:ISSUER`, preventing cross-network asset collisions. Successful but stale connector
results remain raw readings for audit purposes while being excluded from snapshot contributions and current
values. Public supply discrepancies carry both ledger/timestamp identities and exact per-component differences,
so an offsetting component change remains explainable even when the aggregate totals match.

Trustline observations retain exact integer counts for `authorized`, `authorized_to_maintain_liabilities`, and
`unauthorized` classic credit-asset trustlines at one closed ledger. Their `total` must equal the three-state sum.
The public serializer maps the internal `trustline_count` discriminator to `trustline_state`; it does not claim
to measure funded holders, wallets, users, or beneficial owners. Horizon replicas retain one derivation family.

## Asset identifiers

Assets are either:

```json
{ "kind": "native" }
```

or:

```json
{
  "kind": "credit",
  "code": "USDC",
  "issuer": "G..."
}
```

Path input uses `native` or `CODE:ISSUER`. Credit codes are canonical uppercase alphanumeric values of one
to twelve characters. Issuers must use the canonical 56-character Stellar `G...` representation. A future
connector boundary may additionally verify the StrKey checksum when the Stellar SDK is introduced.

## Observations and retrieval attempts

Every observation contains a stable observation ID, cycle ID, metric discriminator, typed metric value, and
provenance. Provenance includes the complete source identity, optional source timestamp, normalized retrieval
timestamp, and optional request correlation ID.

Retrieval attempts are either `success` with one or more observation IDs or `failure` with a structured
source error. Completion cannot precede start time.

## Snapshots

A reconciliation snapshot contains:

- metric, typed network/asset/pair subject, status, typed value, confidence formula/components/caps, and
  methodology version;
- configured, responded, usable, agreeing, and excluded source counts;
- per-observation contributions;
- stateful discrepancies and structured source errors;
- an immutable cycle/snapshot identity and UTC `asOf` timestamp.

The schema enforces source-count ordering and requires unavailable snapshots to have a null value. Available
snapshots must carry a value.

## Discrepancy states

Discrepancies follow methodology v1.5 and keep three independent dimensions:

- severity: `info`, `warning`, or `critical`;
- lifecycle: `open` or `resolved`;
- publication: `internal`, `pending_reply`, `approved_public`, or `withheld`.

The public serializer is fail closed: it emits only discrepancies whose publication state is
`approved_public`. Schema validity alone never authorizes publication.

`GET /api/v1/supply/{asset}` is the first route using this shared v1 serializer. It accepts canonical classic
credit assets on the Public Network and reads finalized database evidence only. When a contribution's persisted
age plus time elapsed since finalization exceeds the supply methodology's 120-second currentness bound, the
snapshot is serialized as `unavailable` with a null value and an explicit `stale_observation` source error; its
original `as_of` remains visible.

## HTTP policy

The canonical prefix is `/api/v1`; the application does not expose `/v1` as an alias. Snapshot routes share
request-ID validation, strict declared-query handling, JSON error envelopes, status semantics, read-only CORS,
conditional weak ETags, and cache policy. `200` snapshot representations use private caches varied by
`X-Request-ID`; `4xx`, `5xx`, and unavailable representations are `no-store`. Supply caps cache freshness plus
stale-while-revalidate at the evidence's remaining time before its hard freshness boundary.

Opaque cursor pagination defaults to 25 and is capped at 100. It applies only to endpoints that explicitly
declare pagination; the implemented singular snapshot routes reject `cursor` and `limit`. Deprecation is also
explicit: a deprecated route must emit `Deprecation`, `Sunset`, and a successor link. Current v1 routes are not
deprecated. Full rationale and status mapping are in
[`ADR 0006`](../decisions/0006-public-http-api-policy.md).

The generated OpenAPI 3.1 artifact derives its response components from these runtime schemas. Its examples are
parsed here before generation, and CI rejects any artifact that differs from deterministic regeneration. Planned
operations are absent from production `paths`; see the [OpenAPI workflow](../openapi.md).

## API compatibility

`tests/fixtures/contracts/reconciliation-snapshot-v1.json` is the initial serialized compatibility fixture.
Changes that alter its field names, types, required fields, or amount/count serialization require an explicit
API compatibility decision. Additive changes must still be reviewed because schemas currently reject unknown
fields deliberately.

The latest-ledger worker runs through the shared domain orchestrator and atomically persists its domain snapshot.
The route reads that finalized snapshot but deliberately retains the named `latest-ledger-v0.2` compatibility
response. [ADR 0003](../decisions/0003-latest-ledger-diagnostic-compatibility.md) records the response-shape and
network-boundary decision. A future versioned API may expose the shared v1 snapshot serializer directly.
