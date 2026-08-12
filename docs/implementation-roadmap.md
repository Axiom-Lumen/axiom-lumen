# Axiom Lumen public roadmap

This document describes Axiom Lumen's shipped capabilities and broad product direction. It intentionally does
not publish internal sequencing, delivery estimates, operational details, or security implementation plans.

For the exact behavior available today, use the [README](../README.md), generated
[OpenAPI contract](../openapi/openapi.json), and versioned [methodology](./methodology/onchain-asset-supply-v0.1.md).
Items below are directional and are not commitments to a particular scope or release date.

## Available today

- A Next.js public product and documentation surface.
- A PostgreSQL-backed ingestion and reconciliation pipeline with durable snapshots and audit history.
- Resilient source collection with bounded concurrency, retries, circuit breakers, and source-health tracking.
- Versioned reconciliation primitives for freshness, weighting, agreement, spread, confidence, and discrepancy
  lifecycle state.
- A persisted latest-ledger diagnostic API for the Stellar Public Network.
- A persisted on-chain credit-asset supply API with explicit freshness and unavailable behavior.
- Persisted classic SDEX depth and credit-asset trustline-state APIs with explicit methodology and freshness.
- Verified SEP-1 anchor attribution, internal publication-gated exact-unit reserve comparison, and a durable
  fail-closed notification/review workflow whose reply clock starts only after successful notice.
- Expiring SEP-1 domain claims, authenticated immutable replies, evidence controls, flag-ID disputes, and
  append-only corrections/retractions behind the internal publication gate.
- Runtime-validated public API contracts, consistent HTTP behavior, OpenAPI 3.1 documentation, and contract
  parity checks.
- Server-rendered supply confidence artifacts and a live homepage reconciliation strip with explicit degraded,
  stale, unavailable, and empty states.
- An API-derived reconciliation dashboard with confidence, source-health, and publication-approved discrepancy
  context.
- Automated lint, type, unit, integration, database, contract, and production-build checks.

## Direction

Future work may broaden the product in these areas:

- Additional reconciliation views where the public contract exposes sufficient evidence.
- Additional Stellar network metrics where semantics and independent evidence can be defined precisely.
- Carefully governed issuer and anchor comparison workflows.
- Production-grade access, event delivery, observability, and reliability capabilities.
- Expanded replay, load, failure, and end-to-end verification.

New public capabilities will be documented only after their contracts, methodology, failure behavior, and
disclosure rules are defined and tested.

## Product and engineering principles

- Public values retain source, time, confidence, and methodology context.
- Source failures remain distinct from numeric disagreements.
- Stellar amounts use decimal-safe arithmetic.
- Multiple replicas of one upstream data class do not imply independent corroboration.
- Methodology changes are versioned and documented.
- Named-party discrepancies fail closed unless their publication state permits disclosure.
- Public copy reports measured evidence and does not infer intent, solvency, fraud, or investment suitability.

## Tracking work

Repository issues and pull requests are the public record for work that is ready for external discussion. The
maintainers keep detailed prioritization, dependencies, internal acceptance criteria, and operational planning
in private project systems.

Contributions should follow [CONTRIBUTING.md](../CONTRIBUTING.md). A proposed change should describe its public
contract, methodology impact, failure behavior, tests, and documentation without relying on unpublished plans.
