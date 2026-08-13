# Operations runbook index

OPS-02 defines the production recovery contract. Every incident must have an incident commander, a timestamped
internal timeline, and one person explicitly responsible for external communication. Never paste credentials,
raw evidence, claimant material, database URLs, or unpublished named-party cases into tickets or chat.

## First response

1. Acknowledge the alert, assign severity and incident commander, and record the UTC start time.
2. Preserve logs, trace/cycle/request IDs, deployment version, migration version, and relevant immutable events.
3. Stop additional harm with the narrowest reversible control: pause a worker, disable one source, disable
   publication, or stop promotion. Do not delete or rewrite evidence.
4. Follow the matching runbook below and maintain a UTC decision log.
5. Validate recovery through readiness, metrics, a representative API read, and persisted evidence before closing.
6. Record impact, root cause, detection gap, corrective actions, owners, and due dates within two business days.

## Runbooks

- [Data protection, PITR, restore drills, and retention](./data-protection.md)
- [Credential rotation](./credential-rotation.md)
- [Upstream outage and stuck worker](./ingestion-recovery.md)
- [Bad migration and application rollback](./release-recovery.md)
- [Notification failure and public correction](./publication-recovery.md)

Production ownership, paging destinations, database-provider commands, deployment commands, and communication
channels are environment-specific controlled configuration. A production environment is not ready until those
fields are populated in the private operator system and exercised in a drill.

Related controls:

- [Production-readiness gate](../releases/production-readiness.md)
- [Threat model](../security/threat-model.md)
