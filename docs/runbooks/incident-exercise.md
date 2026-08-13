# Incident exercise and rollback rehearsal

Use this runbook quarterly and before the first production promotion of a new major release train.

## Objectives

- Assign an incident commander and communications owner before the exercise starts.
- Practice detection, containment, rollback, and recovery without mutating production evidence.
- Produce evidence for the `incident_exercise` production-readiness sign-off.

## Scenario

A promoted worker stops finalizing latest-ledger cycles while the web tier remains ready. Operators must:

1. Detect the failure through `/status`, `/api/metrics`, or paging.
2. Record UTC timestamps, deployment digest, migration version, and affected feature flags.
3. Roll back web and worker to the last known-good digest with `release-rollback.yml`.
4. Confirm readiness, representative API reads, and a newly finalized latest-ledger cycle.
5. Document whether schema compatibility was correctly attested.

## Steps

1. Start the exercise in a non-production environment when possible. For production-shaped rehearsal, use staging with isolated credentials.
2. Announce the exercise start time and commander in the private operator system.
3. Inject or simulate the failure by scaling the worker to zero or deploying a known-bad feature flag combination that fails smoke.
4. Follow [release recovery](./release-recovery.md) and [ingestion recovery](./ingestion-recovery.md) without deleting audit rows.
5. End the exercise only after:
   - readiness succeeds;
   - `/status` returns operational or degraded, not outage, for a persisted-data failure unrelated to the database;
   - release smoke passes for enabled representative routes;
   - the rollback owner and communications owner are named in the decision log.

## Evidence to record

Capture in the private operator system and reference from `production-readiness.record.json`:

- exercise date, commander, and participants;
- injected failure and detection source;
- rollback build run ID and digest;
- UTC timeline of detect, contain, rollback, and verify;
- gaps found and corrective actions.

Record the sign-off:

```bash
npm run release:readiness-signoff -- \
  --id incident_exercise \
  --reviewer "<commander>" \
  --evidence-ref "<private operator exercise record>" \
  --recorded-at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
```
