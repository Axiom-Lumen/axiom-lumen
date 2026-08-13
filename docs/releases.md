# Environments and releases

REL-01 defines four isolated environments and one immutable promotion path. Development uses
`compose.release.yml`; preview, staging, and production use separate Kubernetes namespaces named
`axiom-preview`, `axiom-staging`, and `axiom-production`. Databases, runtime secrets, migration credentials,
backup storage, API principals, ingress, and DNS must be separate for every namespace. No environment may share
a database or credential value with another environment.

## Runtime contract

One OCI image contains three independently selected units:

- `web` runs the Next.js server;
- `worker` runs continuous ingestion and anchor workflow processing;
- `migrate` applies committed forward-only Drizzle migrations.

The same image also exposes `backup` and `backup-check` operational roles. Production Kubernetes manifests
schedule daily encrypted backups and hourly freshness/authenticity checks against the `axiom-backups` claim. That
claim must use a separately administered, versioned, retention-locked object-storage CSI backend. Cluster alerting
must page on CronJob failure or missed schedules.

Containers run as UID 10001 with no privilege escalation, a read-only root filesystem, dropped capabilities, and
no service-account token. Writable cache and temporary paths are explicit ephemeral volumes.

## Managed environment configuration

Create protected GitHub environments named `preview`, `staging`, and `production`. Staging and production require
reviewers; production additionally restricts deployments to reviewed release refs. Each environment provides:

| Kind | Name | Purpose |
| --- | --- | --- |
| GitHub secret | `KUBECONFIG_B64` | Namespace-scoped deploy identity; it cannot read or mutate other namespaces. |
| GitHub secret | `AXIOM_SMOKE_API_KEY` | Short-lived key scoped to every representative smoke route. |
| GitHub variable | `AXIOM_BASE_URL` | Credential-free HTTPS origin for the environment. |
| GitHub variables | `AXIOM_SMOKE_ASSET`, `AXIOM_SMOKE_PAIR`, `AXIOM_SMOKE_ANCHOR` | Seeded representative resources. |
| Kubernetes secret | `axiom-runtime-env` | Runtime database, site key, connector, relay, and encryption settings. |
| Kubernetes secret | `axiom-migration-env` | Direct DDL-capable `DATABASE_MIGRATION_URL` only. |
| Kubernetes secret | `axiom-backup-env` | Read-only backup URL, keyring, environment ID, and backup directory. |

Provision these through the platform secret manager and workload identity; never generate plaintext secret YAML
in this repository or workflow logs. The cluster namespaces, secrets, ingress, TLS, external backup claim, network
policies, monitoring rules, and database instances are platform prerequisites. Release workflows deliberately do
not create or broaden those trust boundaries.

## Build and promotion

`release-build.yml` runs the complete CI and dependency gates, builds one image, and pushes it to GHCR. It then
pulls that exact digest and exercises its migration, web, worker, backup, backup-check, unsupported-role, non-root,
and PostgreSQL 16 client contracts against an ephemeral database. Only after this image-level acceptance gate
succeeds does the workflow attest its SBOM and max-mode provenance and upload `release-manifest.json`. The manifest
binds the commit, build run, registry image, immutable digest, and successful gates; an image that fails acceptance
is never represented by a promotable manifest.

Run `release-promote.yml` with that successful build run ID. Promotion downloads the manifest rather than
rebuilding. Before cluster credentials are loaded, it verifies the requested run succeeded under
`release-build.yml`, checks out the manifest's exact commit, verifies the signed OCI provenance and attached SPDX
SBOM, and binds the repository, run, registry path, commit, and digest. For staging and production it executes a
fresh authenticated backup check for every promotion attempt, then runs a uniquely named digest-pinned migration
job. Both jobs have a ten-minute execution deadline; failures capture diagnostics and remove the failed job before
the workflow exits. Only after migration succeeds are web and worker updated from the exact same digest. Web uses
a zero-unavailable rolling update; the singleton worker uses `Recreate` so completion of its rollout proves the old
worker has stopped. Smoke checks then prove:

- liveness reports the expected digest, commit, environment, and feature flags;
- database readiness succeeds;
- the replacement worker finalizes a latest-ledger cycle after its rollout, and each enabled representative metric
  route returns HTTP 200 with its published response schema;
- disabled metric routes return the exact `feature_not_available` contract rather than another 4xx response.

Feature inputs control supply, depth, trustline, anchor-reserve serving and worker discovery. Disabling a metric
fails its public route closed and prevents discovery of new reconciliation cycles; handlers remain available only
to drain work that was already queued or leased before the flag changed. Named-party publication remains an
independent false-by-default control and may be enabled only after the approval required by ADR 0001. Promotion is
serialized per environment.

## Development and preview

Start an isolated local release topology with:

```bash
docker compose -f compose.release.yml up --build
```

Preview uses the same immutable artifact and promotion workflow as staging and production, but skips the protected
backup preflight and does not schedule production backups. Preview remains manual because forked pull requests do
not receive deployment credentials.

## Rollback

Use `release-rollback.yml` with the build run ID of the last known-good digest. The operator must explicitly attest
that the older web and worker are compatible with the current forward-only schema and select the metric flags to
restore. Rollback never runs a down migration and forces named-party publication off. It redeploys both units from
the recorded digest and repeats the same post-rollout worker-progress and representative-route smoke checks.

If compatibility is uncertain, disable affected feature flags and use a reviewed forward fix. Database recovery
uses PITR or restore into a new instance as described in the [release recovery runbook](./runbooks/release-recovery.md),
never destructive schema reversal.

## Production-readiness gate

REL-02 keeps public v1 unsigned until restore drills, an incident exercise, independent security and methodology
reviews, product/legal publication approval, and named on-call/rollback owners are recorded. The executable
record is [`production-readiness.record.json`](./releases/production-readiness.record.json). Promotion into
isolated environments may continue; marketing and pricing must not describe general availability while that
record is unsigned. See the [production-readiness guide](./releases/production-readiness.md) and
[threat model](./security/threat-model.md).

Release smoke also exercises `/status` and `GET /api/v1/events/snapshots` so documented public reads are not
labeled available without a promotion check.
