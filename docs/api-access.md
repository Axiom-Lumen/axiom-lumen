# API-key access and quotas

The public v1 routes support database-backed API-key authentication and atomic per-plan, per-route fixed-window quotas.
Local development remains anonymous unless `AXIOM_API_AUTH_REQUIRED=true` is set. Production refuses to start
API or first-party data work unless that variable is explicitly `true` or `false`; hosted API deployments set it
to `true` after provisioning a plan, principal, and key. An invalid/missing production setting or unavailable
access store fails closed with `503`; missing, malformed, expired, revoked, or inactive credentials all return
the same `401` response.

All server-rendered first-party confidence artifacts require a dedicated `AXIOM_SITE_API_KEY` when authentication
is enabled. Use a separately revocable principal with sufficient quota. The key is validated during server
rendering, added only to server-side fetches, and never exposed to the browser; periodic browser polling is
disabled in required-auth mode.

## Provisioning

Plans define a positive `requests_per_window` and `window_seconds`. Principals belong to one enabled plan and
must be granted the scopes used by their routes: `metrics:read` for ledger, supply, depth, and trustline reads;
`anchors:read` for public anchor reserve disclosures; and `events:read` for snapshot SSE. Create those operator-controlled records through the
deployment's database administration workflow, then issue a key:

```sql
INSERT INTO api_scopes (id, description) VALUES
  ('metrics:read', 'Read public reconciliation metrics'),
  ('anchors:read', 'Read public anchor reserve disclosures'),
  ('events:read', 'Stream public snapshot events')
ON CONFLICT (id) DO NOTHING;

INSERT INTO api_principal_scopes (principal_id, scope_id)
VALUES ('<principal-id>', 'metrics:read');
```

```bash
npm run api:key-create -- --principal '<principal-id>'
npm run api:key-create -- --principal '<principal-id>' --expires-at '2027-01-01T00:00:00Z'
```

Issuance rejects missing/inactive principals, disabled plans, and expiration timestamps that are not in the
future, so a successful command never knowingly returns an unusable credential.

The command prints the complete `axl_live_...` key once. Only its SHA-256 digest and non-secret 12-character
lookup prefix are persisted. Store the plaintext in the caller's secret manager; it cannot be recovered from
PostgreSQL. Revoke without supplying the secret:

```bash
npm run api:key-rotate -- --prefix '<12-character-prefix>'
npm run api:key-revoke -- --prefix '<12-character-prefix>'
```

Rotation creates and displays one replacement secret and revokes the old key in the same transaction. Creation,
rotation, and revocation append immutable `api_key_events`; pass `--actor '<operator-id>'` to any lifecycle
command to attribute the operation. Key and audit records contain no plaintext secret.

Send the key as `X-Axiom-Key`. CORS preflight remains unauthenticated and permits that header. Authenticated
application responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
`X-RateLimit-Reset`; the reset value is a UTC Unix timestamp. An exhausted window returns `429`, those same
headers, and integer-seconds `Retry-After`.

## Quota semantics

One request consumes one unit before route validation or read-model work begins. Invalid correlation IDs are
rejected before authentication, and `OPTIONS` does not consume quota. PostgreSQL performs sustained and burst
increments in one transaction and refuses increments beyond either limit, so concurrent application replicas
cannot oversubscribe a quota. Usage is isolated by principal and stable route ID; consuming supply quota cannot
consume depth quota. A denied request never reaches the metric read model.

Without a route override, each route receives the plan's sustained window independently and a burst allowance
of up to 10 requests per second, or the smaller sustained limit. Configure an explicit per-plan route policy
when a route needs different sustained or burst behavior:

```sql
INSERT INTO api_plan_route_limits
  (plan_id, route_id, requests_per_window, window_seconds, burst_requests, burst_window_seconds)
VALUES
  ('developer', 'stellar.supply', 600, 60, 20, 1);
```

Stable route IDs are `stellar.latest-ledger`, `stellar.supply`, `stellar.depth`, `stellar.trustlines`, and
`anchors.reserves`; snapshot SSE uses `events.snapshots`. Setting an override's `enabled` field to `false` denies that plan access to the route.
Scope or route-policy denials return `403` without consuming quota. Authentication, scope, plan, and quota-store
failures are fail-closed when hosted authentication is enabled; explicitly anonymous local mode does not access
or mutate quota state.

Quota windows are operational counters rather than permanent audit evidence. Schedule bounded cleanup; the
default retention is seven days and each invocation deletes at most 1,000 rows:

```bash
npm run api:quota-prune
npm run api:quota-prune -- --limit 5000
```

Set `API_QUOTA_RETENTION_HOURS` to change the retention boundary. Re-run until `deleted` is zero when clearing a
large backlog; the indexed, bounded batches avoid a single unbounded deletion.

Keys are rejected when their key record is revoked or expired, their principal is inactive, or their plan is
disabled. Authentication failures intentionally do not reveal which condition failed. Key material must never
be placed in query strings, logs, evidence payloads, browser bundles, or source control.
