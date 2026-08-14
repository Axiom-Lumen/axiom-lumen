# ADR 0006: Public HTTP API policy

- Status: Accepted
- Date: 2026-08-10

## Context

The latest-ledger and supply routes evolved with different missing-data responses, correlation behavior, and
headers. Adding more metrics without a shared boundary would multiply incompatible caching, CORS, validation,
and error semantics. API-02 also requires one canonical public path before an OpenAPI contract is published.

## Decision

The canonical public prefix is `/api/v1`. `/v1` is not a second application route; deployments may place a
gateway in front of the canonical prefix only if it preserves the documented representation and headers.

All implemented v1 snapshot routes:

- accept `GET` and `OPTIONS`, reject query parameters they do not explicitly declare, and validate an optional
  `X-Request-ID`; generated or accepted IDs are returned in `X-Request-ID`;
- return the shared JSON error envelope for request validation, missing snapshots, and read-store failures;
- use `200` for current verified/degraded snapshots, `304` for a matching validator, `400` for invalid input,
  `404` for a valid resource with no finalized snapshot, `405` for unsupported methods, and `503` for persisted
  or read-time unavailability;
- use private response caching, `Vary: X-Request-ID, X-Axiom-Key`, and a weak representation `ETag` only for
  `200` snapshots;
  all errors and unavailable responses use `Cache-Control: no-store`;
- expose public read-only CORS (`Access-Control-Allow-Origin: *`) and a bounded 24-hour preflight cache;
- never expose exception messages, connection strings, credentials, or stack traces.

The hosted contract requires `X-Axiom-Key` with `AXIOM_API_AUTH_REQUIRED=true`; local development remains
anonymous by default, while production requires an explicit true/false choice and fails closed if it is absent.
Required authentication enforces the route's principal scope, then consumes sustained and burst PostgreSQL
fixed-window quota units for the principal and stable route ID before route validation/read work. Unusable
credentials share one `401`, insufficient scope or a disabled plan/route policy returns `403`, and exhausted
windows return `429` with `Retry-After`. CORS preflight is unauthenticated. Lifecycle changes are transactional
and append immutable key audit events; rotation revokes the replaced key as it creates the replacement.

ETags cover the complete representation, including supply's `request_id`, so a validator can return `304` only
when the caller reuses the same correlation ID. Weak comparison accepts either weak or strong syntax for the same
opaque tag. Private caches vary on `X-Request-ID, X-Axiom-Key`, preventing caller correlation or credential
contexts from crossing cache entries.

The default private snapshot cache permits 15 seconds of freshness and 45 seconds of stale-while-revalidate.
Supply further caps the combined cache lifetime at the evidence's exact remaining time before its hard 120-second
limit; near the boundary it becomes immediately revalidated and never receives stale-while-revalidate beyond the
remaining evidence lifetime.

Pagination uses opaque cursors, defaults to 25 items, and permits at most 100. Snapshot routes are not list
resources and therefore reject `cursor` and `limit`; the shared parser is for future list endpoints.

Deprecation is opt-in per route. A deprecated route emits `Deprecation`, `Sunset`, and an HTTP(S)
`rel="successor-version"` link. Current v1 routes are not deprecated and emit none of those headers.

## Consequences

HTTP behavior can be tested once and reused by future metric routes. Invalid preflights and unsupported methods
also pass through the shared envelope and headers. Latest-ledger missing/read failures now use
the same error envelope and `404`/`503` distinction as supply. API-03 can describe one canonical prefix and one
header/status policy without inventing compatibility aliases.
