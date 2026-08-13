# Production-readiness gate

REL-02 keeps public v1 fail-closed until the signed record in
[`production-readiness.record.json`](./production-readiness.record.json) is complete. A successful REL-01
promotion does not declare general availability.

## Required sign-offs

| ID | Meaning | Evidence |
| --- | --- | --- |
| `restore_drill` | Isolated restore or PITR drill against a production-shaped copy | Drill log with RPO/RTO, checksum, tester |
| `incident_exercise` | Incident commander, timeline, and rollback rehearsal | Exercise notes and UTC decision log |
| `security_review` | Independent review of the [threat model](../security/threat-model.md) | Reviewer, finding list, accept/fix decisions |
| `methodology_fixture_review` | Independent review that public constants match fixtures | Reviewer notes against methodology changelog |
| `publication_legal_review` | Product/legal approval required by ADR 0001 | Recorded approval before named-party publication |
| `public_claims_review` | OpenAPI, dashboard, README, pricing, and status match smoke | REL-02 claims audit |
| `slo_oncall_rollback_owners` | Named SLO owners, on-call rotation, and rollback authority | Private operator record referenced by `evidence_ref` |

Accepted rows require `reviewer`, UTC `recorded_at`, and `evidence_ref`. Unsigned rows must leave those fields
null. `public_v1_declared` may be true only when every row is accepted.

## Technical SLOs

These are internal objectives, not a commercial uptime SLA:

- API readiness reflects database/schema availability, not upstream data quality.
- Snapshot freshness warning at 100% of the metric freshness bound and critical at 300%, matching `OPS_*`.
- Cycle lag warning at 120 seconds and critical at 300 seconds.
- Backup RPO of five minutes with continuous PITR; restore RTO of four hours.
- Promotion and rollback authority is the GitHub environment reviewers for `production` plus the named rollback
  owner in the readiness record. Application rollback uses `release-rollback.yml`; database recovery uses PITR
  or restore into a new instance.

Do not publish 99.9% or similar commercial SLAs until hosted operations and the ownership sign-off exist.

## Verification

```bash
npm run release:readiness-verify
npm run release:promotion-policy-verify
npm run release:methodology-fixture-report
npm run release:readiness-signoff -- --id <sign_off_id> --reviewer "<name>" --evidence-ref "<record>"
npm test -- tests/unit/release-readiness.test.ts tests/unit/public-claims.test.ts tests/unit/release-smoke.test.ts
```

Restore-drill evidence is recorded after `npm run ops:restore-drill` using the data-protection runbook. Incident
exercise evidence uses [incident-exercise.md](../runbooks/incident-exercise.md).
