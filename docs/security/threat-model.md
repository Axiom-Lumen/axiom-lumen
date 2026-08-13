# Threat model

This document is the REL-02 engineering threat model. It is not an independent security review. Residual risks
stay unsigned in the production-readiness record until that review is recorded.

Scope is the ingest → reconcile → serve path, operator workflows, and release automation. Out of scope:
multi-chain, WebSockets, self-service claimant UI, and billed self-service.

## Assets

- Append-only readings, snapshots, discrepancy events, cases, replies, and corrections
- Hashed API keys, encrypted webhook secrets, backup keyrings, and migration credentials
- Public metric representations and publication-gated named-party disclosures
- Release manifests, OCI digests, and environment kubeconfigs

## Threats and mitigations

| Threat | Attack | Mitigation already in repository | Residual risk |
| --- | --- | --- | --- |
| Connector egress / SSRF | Worker or discovery follows attacker URLs into internal networks | Scheme, credential, redirect, host, port, size, and timeout bounds; Horizon allow/deny lists | Misconfigured allow lists in a deployed environment |
| Supply or depth manipulation | Poison a replica or publish a false attestation | Replica sources are one derivation family; confidence caps; exact-unit reserve matching; fail-closed stale evidence | Horizon-only results can still be served as degraded |
| Sybil / replica overstatement | Many Horizon URLs presented as independent corroboration | Source-class diversity policy; replicas do not create `verified` independence | Operators can still register redundant replicas |
| Audit tampering | Update or delete discrepancy, case, or key-audit rows | Database append-only triggers; corrections are new events | Privileged DBA roles outside application roles |
| Key theft | Stolen `X-Axiom-Key` or site key | SHA-256 lookup, prefix identification, rotation, revocation, last-used, fail-closed hosted auth | Anonymous local mode if `AXIOM_API_AUTH_REQUIRED` is false |
| Notification spoofing | Forged webhook or email as Axiom Lumen | Signed webhook payloads, encrypted rotatable secrets, first-success clock | Email-relay compromise |
| Denial of service | Quota exhaustion, SSE fan-out, unbounded pagination | Atomic PostgreSQL quotas, bounded replay, slow-consumer shutdown, payload limits, circuit breakers | Shared-plan noisy neighbor; staging capacity still needs environment proof |
| Release substitution | Promote a mutable tag or a different commit | Digest-pinned manifests, signed provenance, SPDX SBOM, exact-commit checkout | Compromised GitHub environment credentials |
| Named-party over-disclosure | Public route reveals internal cases | Publication state filter, empty collections, independent publication flag default false | Enabling the flag without legal sign-off |

## Accepted engineering posture

- Fail closed on disabled metrics, missing production auth policy, and unsigned named-party publication.
- Never log credentials, private endpoint details, or raw exceptions on public surfaces.
- Independent review may accept residual risks or require additional controls; this file does not waive that review.
