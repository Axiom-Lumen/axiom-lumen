# Bad migration and application rollback

Migrations run as a separate promotion step and failure stops deployment. Before migration, confirm a recent
successful backup and PITR health, record the migration set, and test it against a production-shaped restore.

If a migration fails, fence writers and preserve the complete database/provider logs. Prefer a reviewed forward
corrective migration when the schema remains readable and no committed data is corrupt. Never edit the migration
journal or apply ad-hoc destructive SQL. If data or compatibility is unsafe, restore/PITR to a new instance from
immediately before the migration, validate it using the data-protection runbook, rotate credentials, and switch
traffic. Reconcile any writes after the recovery point from durable external records before reopening writers.

Application rollback redeploys the last known-good immutable artifact only when its schema compatibility is
documented. Roll back web and worker independently if safe, disable new publication behavior first, run readiness
and representative reads, then observe one full ingestion interval. A database rollback is always restore or
forward-fix—not a down migration that deletes evidence.
