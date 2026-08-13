# Data protection and recovery

## Recovery objectives and backup schedule

- Managed PostgreSQL continuous WAL archiving/PITR is mandatory in production with a maximum five-minute RPO.
- Take one encrypted logical custom-format backup every 24 hours after the low-traffic ingestion cycle.
- Retain daily backups for 35 days, month-end backups for 13 months, and year-end backups for seven years.
- Store backups in a separate account/project and failure domain with provider-side encryption, object versioning,
  retention lock, access logs, and deletion protection. Backup credentials are read-only database credentials.
- The deployment scheduler must run `ops:backup` daily and `ops:backup-check` after each backup and at least hourly.
  Page on a non-zero check or if the provider's WAL archival monitor is delayed by ten minutes. Backup success is
  not recovery proof; REL-01 owns the environment-specific scheduler, object-store upload, and paging binding.

Run a logical backup with `DATABASE_BACKUP_URL` and an absolute, protected `DATABASE_BACKUP_DIRECTORY`:

```bash
npm run ops:backup
```

The command exports one repeatable-read PostgreSQL snapshot, records exact audit-table counts, encrypts the custom
dump with AES-256-GCM, authenticates its manifest with a derived HMAC key, and leaves only mode-0600 `.dump.enc`
and manifest files. `DATABASE_BACKUP_ENCRYPTION_KEYS` and its active key ID must come from a versioned secret manager. Move both objects
together to protected storage; plaintext exists only as a protected partial file and is removed before success.
Run `npm run ops:backup-check` to authenticate, checksum, and enforce the 26-hour default freshness bound.

## Restore drills and PITR

Run a logical restore drill monthly and before changing backup providers. Use an isolated restore server with no
production network route. The command verifies the manifest checksum, creates a random `axiom_restore_*` database,
restores with fail-fast semantics, checks core schema and append-only triggers, then drops only that database:

```bash
DATABASE_RESTORE_DRILL_ACK=CREATE_AND_DROP_EPHEMERAL_DATABASE \
  npm run ops:restore-drill -- --backup /protected/axiom-lumen-....dump.enc
```

Quarterly, perform a provider PITR drill to a new isolated instance at a randomly selected timestamp at least 24
hours old. Confirm the latest committed ingest cycle at or before the target, reconcile row counts against the
source instance, exercise immutable-trigger rejection, and run a representative API read. Record requested and
actual recovery points, RPO, RTO, checksum, backup identifier, migration version, tester, and result. Target RTO is
four hours. Two consecutive failed drills page the service owner and block production promotion.

After a successful isolated drill, record the `restore_drill` production-readiness sign-off:

```bash
npm run release:readiness-signoff -- \
  --id restore_drill \
  --reviewer "<tester>" \
  --evidence-ref "<private drill record with checksum and migration version>" \
  --recorded-at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
```

The command rejects a restore server with the same host/port or environment identity recorded in the authenticated
manifest. Never override this guard outside the database integration test. Never restore over the existing production database. For disaster recovery, restore/PITR to a new instance,
validate it, fence writers, rotate database credentials, switch traffic, and retain the old instance read-only
until the incident is closed.

## Retention by data class

| Data class | Retention | Disposal rule |
| --- | --- | --- |
| Retrievals, raw readings, snapshots, contributions, discrepancy/case events, replies, reviews, corrections, claims, verification and delivery attempts | Indefinite | Never delete or mutate; corrections and retractions are new linked events. |
| Open projections and source-health state | Lifetime of service | Mutable only through application state transitions backed by immutable history. |
| Snapshot SSE events | Indefinite until a reviewed archival migration exists | Preserve monotonic IDs and replay/audit linkage. |
| API quota buckets | 168 hours by default | Prune only with `api:quota-prune`; not audit evidence. |
| Structured operational logs | 90 days hot, 365 days archive | Redacted logs only; restrict access and expire through the log platform. |
| Backup artifacts | 35 daily, 13 monthly, 7 yearly | Provider lifecycle only after a successful newer restore drill; retain manifests with dumps. |
| Claimant evidence containing personal data | Collection disabled until a documented legal basis and jurisdiction-specific schedule are approved | Uploaded bytes are separately stored and may be cryptographically erased after approval while hashes and audit decisions remain. Inline statements require restricted retention or a reviewed forward migration; they are not currently erasable. |

### Personal-data map and requests

`anchor_contact_endpoints.endpoint`, `anchor_replies.submitted_by/body/evidence`, `anchor_disputes.body`,
`anchor_reviews.notes`, claimant/case event payloads, evidence URLs, and separately stored uploads may contain
personal data. These fields are access-restricted and must not be copied into incident systems or logs. Operator
collection remains disabled unless legal/product has recorded purpose, jurisdiction, retention, data-subject
request handling, and litigation-hold rules.

Every request requires identity verification, legal approval, a litigation-hold check, and a field-level data map.
Append a correction/retraction when the factual record changes. Separately stored upload payloads may be destroyed
under an approved request while retaining their content hash and non-personal audit metadata. Inline immutable text
cannot currently be erased safely; a legal requirement to erase it blocks collection or requires a reviewed
forward migration that replaces the payload with an encrypted erasable reference without deleting audit facts.
