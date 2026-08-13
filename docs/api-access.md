# API-key access and quotas

The public v1 routes support database-backed API-key authentication and atomic per-plan fixed-window quotas.
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

Plans define a positive `requests_per_window` and `window_seconds`. Principals belong to one enabled plan. Create
those operator-controlled records through the deployment's database administration workflow, then issue a key:

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
npm run api:key-revoke -- --prefix '<12-character-prefix>'
```

Send the key as `X-Axiom-Key`. CORS preflight remains unauthenticated and permits that header. Authenticated
application responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
`X-RateLimit-Reset`; the reset value is a UTC Unix timestamp. An exhausted window returns `429`, those same
headers, and integer-seconds `Retry-After`.

## Quota semantics

One request consumes one unit before route validation or read-model work begins. Invalid correlation IDs are
rejected before authentication, and `OPTIONS` does not consume quota. PostgreSQL performs the fixed-window
increment atomically and refuses increments beyond the plan limit, so concurrent application replicas cannot
oversubscribe a quota. A denied request never reaches the metric read model.

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
