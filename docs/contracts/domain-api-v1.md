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

## API compatibility

`tests/fixtures/contracts/reconciliation-snapshot-v1.json` is the initial serialized compatibility fixture.
Changes that alter its field names, types, required fields, or amount/count serialization require an explicit
API compatibility decision. Additive changes must still be reviewed because schemas currently reject unknown
fields deliberately.

The latest-ledger worker runs through the shared domain orchestrator and atomically persists its domain snapshot.
The route reads that finalized snapshot but deliberately retains the named `latest-ledger-v0.2` compatibility
response. [ADR 0003](../decisions/0003-latest-ledger-diagnostic-compatibility.md) records the response-shape and
network-boundary decision. A future versioned API may expose the shared v1 snapshot serializer directly.
