# ADR 0004: PostgreSQL persistence with Drizzle and node-postgres

- Status: Accepted
- Date: 2026-08-10
- Roadmap item: DAT-01

## Context

The target architecture requires PostgreSQL as the durable boundary between background ingestion and public
reads. The project needs explicit, reviewable SQL migrations, TypeScript schema definitions, transaction support
for the upcoming repositories, and compatibility with both long-running workers and pooled managed PostgreSQL.

The web and worker processes must not own production schema changes. Runtime credentials will eventually be
least-privilege application roles, while migration credentials require DDL privileges and must be isolated to a
deployment job.

## Decision

- Use PostgreSQL 16 or later.
- Use Drizzle ORM's code-first PostgreSQL schema and generated SQL migrations. Generated SQL and Drizzle
  migration metadata are committed and reviewed.
- Use `node-postgres` as the runtime driver. It supports bounded connection pools and does not enable prepared
  statements by default, which keeps it compatible with common transaction-pooling deployments.
- Create at most one pool per worker or web process. `DATABASE_POOL_MAX` is bounded and defaults to five; the
  deployment must size aggregate process pools below the provider's connection limit.
- Use `DATABASE_URL` only for runtime queries and `DATABASE_MIGRATION_URL` only for explicit migration commands.
  Production supplies a direct, DDL-capable migration URL to a release job. Runtime URLs may point at a managed
  pooler and must not carry schema-change privileges.
- Use `drizzle-kit generate` for versioned forward SQL and `drizzle-kit migrate` only from developer or release
  tooling. `drizzle-kit push` is not a production workflow.
- Store instants as PostgreSQL `timestamp with time zone`. Application boundaries continue to normalize them to
  canonical UTC strings.
- Preserve domain identifiers as text rather than introducing unrelated database-generated IDs.

Official references: [Drizzle PostgreSQL drivers](https://orm.drizzle.team/docs/get-started-postgresql),
[Drizzle migration flow](https://orm.drizzle.team/docs/migrations), and
[`node-postgres` pooling](https://node-postgres.com/features/pooling).

## Initial model

The initial migration includes networks, assets, sources and credential references; ingest cycles, retrieval
attempts, raw readings and source health; snapshots and contributions; discrepancies and append-only events;
anchor discovery and case workflow records; and API principals, hashed keys, scopes, plans and quota usage.

Foreign keys default to restrictive deletion so audit relationships cannot disappear transitively. Idempotency
keys, lifecycle checks, UTC timestamps, and read-path indexes are expressed in SQL rather than left as application
conventions. DAT-02 adds repository transactions and database-enforced append-only records.

## Migration and rollback policy

- Forward migrations must succeed on an empty database and on the tested representative prior schema.
- Production migrations run once as a separate release job before code that requires the new schema is promoted.
- A failed migration stops promotion. Recovery uses a database restore or a reviewed forward corrective migration;
  destructive down migrations are not generated automatically.
- Schema changes that rewrite or drop data require a backup/restore plan and a staged expand-migrate-contract
  rollout.

## Consequences

- Schema and SQL remain reviewable together, while repositories can use inferred TypeScript types.
- Connection limits remain an explicit deployment responsibility rather than an unbounded library default.
- Web requests cannot accidentally run migrations because application modules expose no migration entry point.
- PostgreSQL-backed migration tests become a required CI gate for persistence changes.
