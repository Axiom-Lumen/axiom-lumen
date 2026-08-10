# Database development and migrations

DAT-01 introduces PostgreSQL schema and migration tooling. DAT-02 adds the transactional repository boundary and
database-enforced immutable audit records. ING-01 adds durable scheduler leases, worker writes, and a persisted
latest-ledger read path. ING-02 adds durable source-health and circuit-breaker projections. SUP-04 reuses the
same atomic boundary for supply evidence, reconciliation snapshots, and discrepancy events, and pins each newly
scheduled lease to a digested job-definition snapshot.

## Configuration

- `DATABASE_URL`: pooled, least-privilege runtime connection used by web or worker processes.
- `DATABASE_MIGRATION_URL`: direct DDL-capable connection used only by explicit migration tooling.
- `DATABASE_POOL_MAX`: maximum connections in one application process; defaults to `5`.
- `DATABASE_IDLE_TIMEOUT_MS`: idle connection timeout; defaults to `30000`.
- `DATABASE_CONNECTION_TIMEOUT_MS`: connection acquisition timeout; defaults to `5000`.

Never commit real URLs or log them. Aggregate pool capacity across all process instances must remain below the
database provider's connection limit.

## Local workflow

Start the isolated PostgreSQL service:

```bash
docker compose -f compose.database.yml up -d
```

Generate and validate migration metadata after changing `lib/db/schema.ts`:

```bash
npm run db:generate
npm run db:check
```

Apply committed migrations explicitly:

```bash
DATABASE_MIGRATION_URL=postgresql://axiom:axiom@127.0.0.1:55432/axiom_lumen npm run db:migrate
```

Run migration integration tests:

```bash
DATABASE_TEST_ADMIN_URL=postgresql://axiom:axiom@127.0.0.1:55432/postgres npm run test:database
```

Worker setup, source registration, lease behavior, and one-shot/continuous commands are documented in
[worker.md](./worker.md).

Stop the service with `docker compose -f compose.database.yml down`. Add `-v` only when intentionally discarding
the local database volume.

## Production rule

Migrations are a dedicated release operation using `DATABASE_MIGRATION_URL`. They are never imported by the
Next.js route layer and never run during a web request or ordinary application startup. Failed migrations stop
promotion; rollback follows ADR 0004's restore-or-forward-fix policy.

## Repository and audit boundary

`createPersistenceRepositories` in `lib/db/repositories.ts` exposes the supported persistence operations. A
completed cycle, retrieval attempts, sanitized raw readings, source-health samples, snapshot, contributions,
discrepancy projections, and append-only events are committed in one transaction. Duplicate cycle idempotency
keys return the existing cycle without repeating any child writes. Notification enqueueing likewise uses a
unique idempotency key.

Raw payloads are canonicalized and recursively replace common credential-bearing fields such as authorization
headers, cookies, API keys, tokens, and passwords before hashing and storage. The SHA-256 digest therefore
verifies the exact sanitized evidence retained in the database without deriving a digest from discarded secrets.
Connectors must still avoid putting unrelated personal or secret data into evidence.

Every raw reading stores a validated copy of its complete source identity. A successful supply reading also keeps
the complete normalized observation—ledger, component vector, total, derivation/checkpoint metadata—and its
connector evidence. API reconstruction uses immutable evidence rather than the mutable source registry,
preserving the endpoint and source class observed at collection time. The ING-01 migration backfills existing
readings from their referenced source/network rows before making the identity field mandatory.

The following evidence tables reject `UPDATE`, `DELETE`, and `TRUNCATE` through PostgreSQL triggers, even if an
application role is accidentally granted those privileges: retrieval attempts, raw readings, source-health samples,
snapshots, snapshot contributions, discrepancy events, anchor replies, reviews, and corrections. Resolution,
correction, and retraction are linked new events; they never overwrite the original. Projection tables such as
`discrepancies` and `source_health_states` remain mutable because their history is represented by immutable
events or source-health samples. Health projection updates use `last_observed_at` ordering so a delayed older
cycle cannot overwrite newer circuit state.

Audit events and referenced evidence have indefinite retention by default. Any future retention policy must be a
reviewed forward migration that preserves evidence referenced by unresolved discrepancies; ordinary application
credentials have no deletion path.
