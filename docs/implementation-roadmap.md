# Axiom Lumen implementation roadmap

> Status: proposed execution plan
>
> Baseline: `origin/main` at `49c3457` (2026-08-09)
>
> Canonical product rules: [`axiom-lumen-agent-guide.md`](../axiom-lumen-agent-guide.md)
>
> Scope: remaining work from the current latest-ledger vertical slice to a production-capable v1

## 1. Purpose

This document is the ordered implementation plan for Axiom Lumen. It replaces
`docs/issue-backlog.md` as the execution source of truth because that audit predates the latest-ledger
API, automated tests, CI, npm migration, dynamic confidence component, and Horizon network validation.
The older backlog remains useful as historical research, but its statements about repository state are
no longer current.

Work should normally proceed from top to bottom. A later item may start early only when all of its
dependencies are complete and doing so does not create a second implementation of a shared contract.

## 2. Current baseline

### Implemented

- Next.js 16 application with public marketing, documentation, methodology, anchor, and pricing pages.
- `GET /api/v1/stellar/latest-ledger` as the first complete ingest → reconcile → serve slice.
- Multiple configured Horizon endpoints with URL normalization, timeouts, structured source errors,
  network-passphrase validation, and mismatched-network exclusion.
- Latest-ledger weighted median, freshness decay, confidence scoring, status classification, and
  discrepancy output under the narrow `latest-ledger-v0.2` methodology.
- Unit and route integration tests, plus lint, typecheck, test, integration-test, and build CI gates.
- A client-side confidence example with loading and illustrative fallback states.

### Incomplete or misleading surfaces to address early

- The homepage reconciliation strip is hardcoded and labeled live.
- `ConfidenceJson` requests `/api/v1/supply/USDC`, which does not exist, and therefore normally shows
  illustrative fallback data.
- The public methodology describes v1.3, but executable shared v1.3 configuration does not exist.
- Latest-ledger v0.1 logic is monolithic and uses thresholds not governed by the published v1.3 rules.
- The severity table, agent guide, and anchor-process copy disagree about thresholds and timing.
- PostgreSQL persistence, scheduler leases, durable readings/snapshots, source-health samples, and append-only
  discrepancy events are implemented for the latest-ledger slice.
- Per-source retry budgets, bounded backoff, circuit breakers, concurrency/response limits, and durable health
  projections are implemented for the latest-ledger worker.
- Supply connectors/reconciliation, trustline, DEX depth, anchor reserve, authentication, rate limiting,
  streaming, and operational status surfaces remain planned.
- Several broader product surfaces remain static or planned; current status is maintained in the README and this
  roadmap rather than the historical issue backlog.
- `tsconfig.tsbuildinfo` is tracked even though it is generated build output.

## 3. Non-negotiable engineering rules

1. Keep every capability inside the **INGEST → RECONCILE → SERVE** architecture.
2. Preserve raw observations and append changes; never delete discrepancy history.
3. A returned metric must include confidence, source counts/context, discrepancies, UTC `as_of`, and a
   methodology version. A bare value is invalid.
4. Use decimal-safe arithmetic for Stellar amounts. JavaScript `number` is acceptable for bounded scores,
   ages, counts, and ledger sequences, but not seven-decimal asset quantities.
5. Source failures are not data disagreements. Model transport, validation, exclusion, and discrepancy
   outcomes separately.
6. Multiple Horizon servers observing the same ledger improve availability but are not automatically
   independent source classes. Confidence policy must not overstate source diversity.
7. Methodology changes require a version bump, changelog entry, fixture updates, and synchronized public
   documentation.
8. Warning or Critical anchor-facing output must have a right-of-reply state and human-review path before
   public disclosure.
9. Use factual deviation language only. Never infer solvency, fraud, intent, financial health, or investment
   suitability.
10. Every work item must ship with tests, documentation, and operational failure behavior proportional to
    its risk.

## 4. Target architecture

```text
                           ┌─────────────────────┐
Horizon / Core / Archive ─▶│                     │
SDEX / trade streams      ─▶│  INGEST adapters   │──▶ raw_readings
Anchor / oracle endpoints ─▶│ + source health    │
                           └──────────┬──────────┘
                                      │
                                      ▼
                           ┌─────────────────────┐
                           │ RECONCILE           │
                           │ normalize → weight  │
                           │ → median → score    │
                           │ → classify          │
                           └──────────┬──────────┘
                                      │
                    snapshots + append-only discrepancy events
                                      │
                                      ▼
                           ┌─────────────────────┐
                           │ SERVE               │
                           │ REST + SSE          │
                           │ dashboard + status  │
                           │ anchor case tooling │
                           └─────────────────────┘
```

The database is the boundary between background collection and public reads. Public metric routes should
read the latest completed snapshot rather than synchronously fan out to every upstream source. The existing
latest-ledger route may retain a direct mode for local diagnostics, but production behavior should follow the
same durable pipeline as other metrics.

## 5. Delivery model

### Work-item states

- `[ ]` ready or pending
- `[~]` in progress
- `[x]` complete and verified
- `[!]` blocked; the item must name the decision or dependency blocking it

### Pull-request size

Each numbered item below should normally be one pull request. Split an item when review becomes difficult,
but do not combine unrelated phases. Every PR must state:

- roadmap ID and audience served;
- behavior added and behavior explicitly excluded;
- migrations or methodology impact;
- tests run and representative fixtures;
- rollback or disable mechanism for operational changes;
- documentation updated.

### Definition of done for every item

- Acceptance criteria are demonstrably satisfied.
- New logic has unit tests; boundaries have integration or contract tests.
- `npm run ci` passes on the supported Node version.
- Error paths do not leak credentials, private endpoint details, or raw internal exceptions.
- User-facing output follows the language and source-context guardrails.
- Configuration is represented in `.env.example` and validated at startup where applicable.
- README, API docs, and methodology docs describe only what is actually available.

## 6. Master execution order

| Order | ID | Deliverable | Depends on | Size |
|---:|---|---|---|---|
| 1 | FND-01 | Rebase development on current `main` and clean generated artifacts | — | S |
| 2 | FND-02 | Reconcile documentation and remove false live claims | FND-01 | S |
| 3 | MTH-01 | Severity and disclosure decision record | FND-02 | M |
| 4 | MTH-02 | Versioned methodology configuration and changelog | MTH-01 | M |
| 5 | MTH-03 | Decimal-safe amount primitives | FND-01 | M |
| 6 | MTH-04 | Shared observation, error, snapshot, and API schemas | MTH-02, MTH-03 | M |
| 7 | REC-01 | Pure weighting and weighted-median modules | MTH-02, MTH-03 | M |
| 8 | REC-02 | Agreement, spread, and confidence modules | REC-01 | L |
| 9 | REC-03 | Stateful discrepancy classifier | REC-02, MTH-01 | L |
| 10 | REC-04 | Metric-agnostic reconciliation orchestrator | REC-03, MTH-04 | L |
| 11 | LED-01 | Migrate and harden latest-ledger vertical slice | REC-04 | M |
| 12 | DAT-01 | Persistence ADR, Postgres schema, and migrations | MTH-04 | L |
| 13 | DAT-02 | Repositories and append-only audit invariants | DAT-01 | L |
| 14 | ING-01 | Scheduler and idempotent reconciliation cycles | DAT-02, LED-01 | L |
| 15 | ING-02 | Retry, backoff, concurrency, and source health | ING-01 | M |
| 16 | SUP-01 | Supply semantics and source-independence ADR | MTH-04 | M |
| 17 | SUP-02 | Horizon on-chain supply connector | SUP-01, ING-02 | L |
| 18 | SUP-03 | Independent supply-source connectors | SUP-02 | L |
| 19 | SUP-04 | Persisted supply reconciliation pipeline | SUP-03, REC-04 | L |
| 20 | API-01 | Persisted `GET /api/v1/supply/{asset}` | SUP-04 | M |
| 21 | API-02 | Shared error envelope, validation, pagination, and caching | API-01 | M |
| 22 | API-03 | OpenAPI 3.1 specification and contract tests | API-02 | M |
| 23 | WEB-01 | Wire confidence example to the real supply endpoint | API-01 | S |
| 24 | WEB-02 | Replace or relabel homepage reconciliation strip | API-01 | M |
| 25 | WEB-03 | Reconciliation dashboard | API-02 | L |
| 26 | DEX-01 | Order-book depth definition and connectors | ING-02 | L |
| 27 | DEX-02 | Persisted depth reconciliation and REST endpoint | DEX-01, REC-04 | L |
| 28 | TRU-01 | Trustline metric definition, connector, and endpoint | ING-02, REC-04 | L |
| 29 | ANC-01 | Anchor registry and `stellar.toml` discovery | DAT-02 | L |
| 30 | ANC-02 | Anchor reserve connector and comparison pipeline | ANC-01, SUP-04 | L |
| 31 | ANC-03 | Right-of-reply cases, notifications, and review controls | ANC-02, REC-03 | XL |
| 32 | ANC-04 | Verified claims, responses, disputes, and corrections | ANC-03 | XL |
| 33 | SEC-01 | API keys, scopes, and secret lifecycle | API-02 | L |
| 34 | SEC-02 | Rate limits, quotas, and abuse controls | SEC-01 | L |
| 35 | EVT-01 | SSE live updates with replay and resume | DAT-02, API-02 | L |
| 36 | OPS-01 | Structured telemetry, health, readiness, and status page | ING-02 | L |
| 37 | OPS-02 | Backups, restore drills, retention, and runbooks | DAT-02, OPS-01 | L |
| 38 | QUA-01 | End-to-end, replay, load, failure, and security test suites | all shipped paths | XL |
| 39 | REL-01 | Deployment environments and release automation | OPS-02, QUA-01 | L |
| 40 | REL-02 | Production-readiness and public-claims review | REL-01, ANC-04 | M |

Sizes are relative: S is narrowly scoped, M spans several modules, L is a vertical slice, and XL should be
split into several reviewable PRs under the same roadmap ID.

## 7. Phase 0 — establish truthful ground truth

### [x] FND-01 — Synchronize and clean the development baseline

**Goal:** ensure all subsequent work starts from merged functionality rather than the already-merged docs
branch.

Tasks:

- Fast-forward local `main` to `origin/main` and create the next feature branch from it.
- Preserve and inspect the existing `tsconfig.tsbuildinfo` modification, then stop tracking generated
  TypeScript build metadata and add the appropriate ignore rule.
- Run `npm ci` and `npm run ci` without application secrets.
- Record the supported Node and npm versions consistently in `.nvmrc`, `package.json`, README, and CI.
- Confirm Horizon network-validation tests are present after synchronization.

Acceptance:

- Clean working tree after a full CI run.
- No tracked build output changes during typecheck or build.
- Local and CI toolchain requirements agree.

### [x] FND-02 — Make documentation match reality

**Goal:** remove stale instructions and fictional runtime claims before adding more features.

Tasks:

- Update `CONTRIBUTING.md` to acknowledge the latest-ledger API, real tests, and current scripts.
- Remove documentation for nonexistent database/ingest scripts or add explicit non-executable roadmap links.
- Label the homepage strip as illustrative until WEB-02 lands.
- Ensure `ConfidenceJson` does not present its fallback as a live response.
- Update docs to reflect network-passphrase validation now present on `main`.
- Link README and contributing docs to this roadmap; mark `docs/issue-backlog.md` historical.

Acceptance:

- Every endpoint shown as implemented exists and has a passing route test.
- Every command shown as runnable exists in `package.json`.
- Static data is visibly labeled illustrative.

## 8. Phase 1 — freeze methodology and shared contracts

### [~] MTH-01 — Resolve severity and disclosure contradictions

**Goal:** make one reviewed rule set authoritative before persisting or publishing discrepancies.

Engineering rules are recorded in ADR 0001 and synchronized as methodology v1.5. Product/legal approval
remains required before named-party publication is enabled; this does not block non-public engine work.

Decision record must resolve:

- whether Warning starts immediately beyond tolerance or only after a persistence threshold;
- whether Critical begins at three refresh cycles, after the 72-hour reply window, or through two distinct
  dimensions (measurement severity versus publication state);
- the exact Info boundary and whether it includes values between tolerance and `2 × tolerance`;
- reconvergence, escalation, de-escalation, and late-data behavior;
- when a named party is notified and when data can be public;
- human override, correction, and retraction rules.

Recommendation: model `severity`, `lifecycle_state`, and `publication_state` separately. A measurement can be
Critical while still withheld for right-of-reply review.

Acceptance:

- An ADR in `docs/decisions/` contains transition tables and worked examples.
- Agent guide, methodology page, anchor page, and severity table use the same rules.
- Legal/product owner approval is recorded for anchor-facing behavior.

### [x] MTH-02 — Create versioned executable methodology configuration

**Goal:** replace duplicated constants with a validated source of truth.

Include:

- methodology and confidence-formula versions;
- source classes and base weights;
- per-metric freshness decay/half-life, tolerance, minimum diversity, and refresh cadence;
- agreement boundaries, confidence coefficients/caps, and severity transitions;
- right-of-reply duration and publication policy references.

Render public methodology tables from this configuration where server-safe. Validate at build/startup and
maintain `docs/methodology/changelog.md`.

Acceptance:

- Tests assert every published constant equals executable configuration.
- Invalid, missing, non-finite, or out-of-range parameters fail validation.
- A documented version-bump procedure updates config, changelog, fixtures, and public copy together.

### [x] MTH-03 — Add decimal-safe Stellar amount primitives

**Goal:** make lossless seven-decimal asset arithmetic the default.

Implement canonical parsing, formatting, comparison, addition/subtraction, absolute/relative delta, and JSON
serialization. Prefer scaled `bigint` for Stellar stroop-level values unless an ADR demonstrates the need for
an arbitrary-precision decimal library. Reject exponent notation, excess precision, non-finite values,
unsafe coercions, and locale-formatted input at trust boundaries.

Acceptance:

- Round trips preserve all seven decimals and values beyond JavaScript's safe integer range.
- Tests cover negatives where allowed, zero-reference percent delta, boundaries, and malformed inputs.
- Public amount fields serialize as decimal strings.

### [x] MTH-04 — Define shared domain and API schemas

**Goal:** establish stable contracts used by connectors, reconciliation, persistence, and routes.

Define runtime-validated discriminated schemas for:

- asset IDs (`native` or `CODE:ISSUER`), trading pairs, networks, metrics, and source identities;
- raw observations, observation provenance, retrieval attempts, and source errors;
- reconciliation snapshots, contributions, confidence components, and discrepancies;
- standard API success/error metadata and methodology versions.

Acceptance:

- Boundary data is parsed, not type-cast.
- Schema fixtures cover backward-compatible serialization.
- Internal camelCase and external snake_case mapping occurs in one adapter layer.

## 9. Phase 2 — build the reusable reconciliation engine

### [x] REC-01 — Extract pure freshness and weighted-median modules

Implement source timestamp preference with receipt-time fallback, non-negative age handling, configurable
decay, zero-weight exclusion, deterministic sorting, and documented tie behavior. Amount comparisons use the
decimal-safe type; ledger sequences remain safe integers.

Acceptance:

- Pure modules have no React, Next.js, HTTP, or database imports.
- Tests cover equal weights, unequal weights, ties, zero weights, single source, stale sources, outliers, and
  deterministic output under input reordering.
- A regression test proves an asymmetric outlier cannot drag the result as a mean would.

### [x] REC-02 — Implement agreement, spread, and versioned confidence

First document the formula and its rationale. Calculate agreement by effective weight, source availability,
source-class diversity, freshness, and normalized spread without presenting confidence as probability of
correctness.

Acceptance:

- Output is finite and bounded `[0, 1]` for all valid inputs.
- More agreement, freshness, availability, or diversity never lowers confidence when other inputs are fixed.
- Single-source and same-upstream replicas are capped according to policy.
- Property-based tests cover bounds and monotonicity; worked fixtures match public methodology examples.

### [x] REC-03 — Implement stateful discrepancy classification

Return measurement severity separately from lifecycle/publication state. Consume prior persisted state and
produce appendable events for opened, observed, escalated, reconverged, resolved, corrected, or retracted
transitions.

Acceptance:

- Boundary and three-cycle tests are deterministic.
- Late/out-of-order readings cannot incorrectly reduce persistence duration.
- Reconvergence appends a resolution; it never deletes history.
- Named-party Warning/Critical records cannot enter a public state without the required review/reply state.

### [x] REC-04 — Build the metric-agnostic orchestrator

Pipeline:

1. validate and normalize readings;
2. separate failures/exclusions from valid observations;
3. compute age and effective weight;
4. calculate reference value, agreement, spread, and confidence;
5. compare against prior discrepancy state;
6. produce a complete immutable snapshot and events.

Acceptance:

- The orchestrator accepts an injected clock and methodology config.
- Same input, prior state, time, and version produce byte-equivalent domain output.
- No partial snapshot is emitted if required invariants fail.
- Golden fixtures cover verified, degraded, unavailable, stale, split-network, and outlier cases.

### [x] LED-01 — Migrate the latest-ledger slice

Move existing behavior onto shared schemas and reconciliation primitives without changing its public contract
accidentally. Decide whether `latest-ledger-v0.2` remains a deliberately separate method or becomes a named
profile under the current methodology. Document the compatibility policy.

Also add deterministic retrieval timestamps, response-schema validation, response-size bounds, endpoint
allow/deny policy, and tests for network identity, redirects, timeouts, malformed roots, duplicate sources,
and all-source failure.

Acceptance:

- Existing route tests remain green or an intentional API version change is documented.
- Network-mismatched sources never contribute to value or confidence.
- Direct diagnostic mode is clearly distinguished from persisted production snapshots.

## 10. Phase 3 — persistence and background execution

### [x] DAT-01 — Select the persistence layer and create migrations

Use PostgreSQL as required by the existing target architecture. Record an ADR for the migration/query tool;
Drizzle with a PostgreSQL driver is a reasonable default for this TypeScript codebase, but the choice must be
validated against deployment and connection-pooling constraints.

Initial entities:

- networks, assets, source definitions, and source credentials references;
- ingest cycles, retrieval attempts, raw readings, and source-health samples;
- reconciliation snapshots and per-source contributions;
- discrepancies and append-only discrepancy events;
- anchors, verified domains/contact endpoints, cases, notifications, replies, reviews, and corrections;
- API principals, hashed keys, scopes, plans, and quota usage.

Acceptance:

- Forward migrations work on an empty database and a representative prior schema.
- Foreign keys, unique idempotency keys, checks, UTC timestamps, and query indexes are explicit.
- Production migrations are never run implicitly by a web request.

### [x] DAT-02 — Implement repositories and audit invariants

Use transaction boundaries to store a completed cycle, its readings, snapshot, and discrepancy events
atomically. Raw payloads should be content-hashed; sensitive fields should be minimized or encrypted.

Acceptance:

- Duplicate cycle/idempotency keys do not duplicate records or notifications.
- Application roles cannot update or delete append-only audit rows.
- Resolution and correction are new events linked to originals.
- Repository integration tests run against real PostgreSQL in CI.

### [x] ING-01 — Add an idempotent scheduler and worker

Separate the worker entry point from Next.js request handling. Implement metric/source job discovery, cycle
leases, bounded concurrency, cancellation, graceful shutdown, and reaping of abandoned leases.

Acceptance:

- Two workers cannot finalize the same cycle twice.
- A crash can be retried safely from the last durable boundary.
- Public routes never wait for a live upstream collection cycle.
- Local one-shot and continuous worker commands are documented and present in `package.json`.

### [x] ING-02 — Add resilience and persisted source health

Implement per-source timeouts, retry budgets, exponential backoff with jitter, `Retry-After`, circuit breakers,
concurrency caps, payload limits, and health-state transitions. Do not retry permanent validation failures.

Acceptance:

- Upstream outages degrade snapshots without taking down unrelated sources.
- Retry behavior is deterministic under a fake clock/random source.
- Health records distinguish unreachable, rejected, malformed, stale, network-mismatched, and healthy states.

## 11. Phase 4 — on-chain asset-supply vertical slice

### [x] SUP-01 — Approve the supply metric specification

The specification, executable invariants, and product/methodology approval of ADR 0005 are complete.

Do not implement supply until its meaning is precise. The ADR must define:

- issued versus circulating supply, native XLM versus issued assets, and issuer-held balances;
- liquidity pools, claimable balances, contract-held balances, clawback, authorization, and sponsored entries;
- ledger-close consistency and pagination snapshot semantics;
- source independence: separate Horizon instances are replicas, not independent economic attestations;
- acceptable independent sources and behavior when only on-chain replicas exist;
- asset/network validation and issuer/home-domain provenance.

Acceptance:

- Worked examples include classic assets, native XLM, and relevant edge cases.
- Public endpoint naming matches what is actually measured.
- Product/methodology review approves the formula and source-diversity policy.

### [x] SUP-02 — Implement the Horizon on-chain connector

Collect a ledger-consistent supply observation using bounded pagination and decimal-safe totals. Emit a
persistence-ready result containing the ledger sequence, source timestamps, request provenance,
page/checkpoint metadata, and normalized amount. SUP-04 owns durable raw-reading and reconciliation persistence.

Acceptance:

- Pagination is complete, resumable, bounded, and tested against duplicates and mid-scan ledger changes.
- Invalid assets, missing issuers, rate limits, malformed records, and partial scans are structured failures.
- Fixture totals are independently calculable.

### [x] SUP-03 — Add genuinely distinct corroborating sources

Implement adapters only for sources approved in SUP-01, such as history/archive-derived state and an
anchor-published/attested figure discovered through verified metadata. Each adapter returns the shared raw
observation contract and never embeds reconciliation logic.

Acceptance:

- At least two approved source classes can be compared for a `verified` supply state; otherwise output is
  transparently capped/degraded.
- Parser and failure tests use recorded, redacted fixtures.
- No anchor-provided value is mislabeled as canonical ledger state.

### [ ] SUP-04 — Run and persist supply reconciliation

Register the metric with the worker, shared methodology, persistence repositories, and discrepancy state
machine.

Acceptance:

- One end-to-end test runs connector fixtures → raw readings → reconciliation → database snapshot/events.
- Replaying the same cycle is idempotent and produces the same result.
- Unavailable or stale sources cannot silently reuse an old value as current.

## 12. Phase 5 — stable API and first live UI

### [ ] API-01 — Implement `GET /api/v1/supply/{asset}`

Read the latest completed persisted snapshot and return the mandatory contract: metric, asset, decimal-string
value, status, confidence with components/version, source counts/context, discrepancies, UTC `as_of`, and
methodology version.

Acceptance:

- Valid, missing, stale, degraded, unavailable, and malformed-asset cases have route tests.
- Staleness is explicit; the route does not imply an old snapshot is live.
- No synchronous upstream fan-out occurs in the request.

### [ ] API-02 — Standardize all HTTP behavior

Add validated parameters, error codes/envelope, request IDs, cache/ETag policy, CORS policy, pagination,
maximum page sizes, deprecation headers, and consistent `200/4xx/5xx` semantics. Decide whether public paths
remain under Next.js `/api/v1` or are externally rewritten to `/v1`; document one canonical form.

Acceptance:

- Latest-ledger and supply routes share response/error helpers.
- Route tests assert headers as well as bodies.
- Internal exception details and secrets never appear in responses.

### [ ] API-03 — Publish OpenAPI 3.1 and enforce contract parity

Generate or validate the specification from shared runtime schemas. Include examples for verified, degraded,
unavailable, validation error, authentication error, and rate limit responses.

Acceptance:

- CI detects schema/spec drift.
- Every documented implemented route has a contract test.
- Planned endpoints are clearly marked or excluded from the production spec.

### [ ] WEB-01 — Wire the confidence artifact

Replace `any` with the shared response type and runtime validation. Fetch the real supply endpoint with clear
loading, empty, stale, degraded, and unavailable states. Keep illustrative output visually and semantically
distinct from live data.

### [ ] WEB-02 — Make the homepage strip truthful and live

Prefer rendering the latest persisted snapshot on the server with periodic client refresh. Display per-source
values only when the metric contract safely exposes them; always include status, confidence, source context,
and `as_of`.

Acceptance for WEB-01 and WEB-02:

- No hardcoded artifact is labeled live.
- Accessibility covers status text without color dependence, focus behavior, and announced refreshes without
  excessive screen-reader noise.
- Responsive and failure-state component tests pass.

### [ ] WEB-03 — Build the reconciliation dashboard

Show current metric status, observations, excluded/failed sources, confidence explanation, methodology link,
and discrepancy timeline. Do not expose named-anchor cases before publication rules permit it.

Acceptance:

- The dashboard derives from API contracts rather than database imports.
- Empty, loading, stale, unavailable, and partial-source states are designed and tested.
- Every number retains source/time/confidence context.

## 13. Phase 6 — broaden metric coverage

### [ ] DEX-01 / DEX-02 — Order-book depth

First define pair canonicalization, price bands, side, aggregation units, ledger/time boundary, liquidity-pool
treatment, and freshness policy. Then ingest Horizon SDEX/order-book and approved corroborating sources,
reconcile decimal-safe depth buckets, persist snapshots, and implement `GET /api/v1/depth/{pair}`.

Required tests: reversed pairs, thin/empty books, crossed/stale books, pagination, rounding, outliers, and
rapid source updates.

### [ ] TRU-01 — Trustline state

Define whether the metric counts all trustlines, authorized trustlines, funded holders, or each separately.
Implement ledger-consistent collection, persistence, reconciliation, and
`GET /api/v1/trustlines/{asset}` with the same contract and staleness behavior.

### [ ] ANC-01 / ANC-02 — Anchor reserve comparison

Build a verified anchor registry from issuing accounts and `stellar.toml`, with SSRF-safe discovery and
redirect/DNS controls. Ingest documented reserve/attestation endpoints, retain provenance, and compare only
commensurate units and timestamps against the approved supply metric. Implement the reserve endpoint only
after publication-state filtering exists.

Acceptance:

- Unverified domains or endpoints cannot be attributed to an anchor.
- Reserve period/currency/unit mismatch becomes unavailable, not a numeric discrepancy.
- Public responses contain only publication-approved cases.

## 14. Phase 7 — right of reply and correction workflow

### [ ] ANC-03 — Case lifecycle, notification, and review

Create cases from eligible discrepancy events, deduplicate notifications, store delivery attempts, and support
email/webhook channels with signed payloads. Implement the 72-hour clock from the approved ADR, reviewer
queues, escalation, and a fail-closed publication gate.

Acceptance:

- Retries cannot send duplicate initial notices.
- Webhook secrets are encrypted and rotated; delivery logs redact sensitive content.
- A failed notification cannot accidentally make a case public.
- Human reviewers see raw evidence, methodology version, timestamps, and prior events.

### [ ] ANC-04 — Claims, replies, disputes, and corrections

Implement expiring single-use domain-control challenges, verified contact management, authenticated replies,
evidence uploads/links with malware and size controls, dispute intake by flag ID, immutable response versions,
and correction/retraction events.

Acceptance:

- Claim tokens are hashed, scoped, expiring, and replay-resistant.
- Anchor replies are never edited in place; public rendering is safe and preserves the original record.
- Corrections are as visible as the publication they correct.
- Authorization and audit tests cover claimant, reviewer, and administrator roles.

## 15. Phase 8 — platform access and real-time delivery

### [ ] SEC-01 — API key lifecycle

Implement principals, scopes, hashed key storage, one-time secret display, prefixes for identification,
rotation, revocation, last-used metadata, and audit events. Keep hosted pricing claims disabled until issuance
and enforcement work end to end.

### [ ] SEC-02 — Rate limits and quotas

Use an atomic shared store, not process memory. Define limits by principal/plan/route, safe anonymous behavior,
standard limit headers, retry timing, burst rules, and fail-open/fail-closed policy by endpoint.

### [ ] EVT-01 — Server-sent events

Ship SSE before WebSocket unless bidirectional behavior is demonstrated. Publish completed snapshot events
with event IDs, heartbeat, authorization, resume via `Last-Event-ID`, bounded replay, backpressure, and slow
consumer handling.

Acceptance:

- Revoked or over-quota clients lose access promptly.
- Multi-instance deployments share quota and event state.
- Disconnect/reconnect tests prove no silent duplicate or skipped event within the replay window.

## 16. Phase 9 — operations, reliability, and release

### [ ] OPS-01 — Telemetry and status

Add structured logs with request/cycle/source correlation IDs, metrics for latency/failures/freshness/cycle
lag/discrepancies, traces across worker and API boundaries, liveness/readiness endpoints, alert thresholds, and
a public `/status` page based on persisted health. Redact URLs or fields that contain credentials.

### [ ] OPS-02 — Data protection and runbooks

Define backup frequency, point-in-time recovery, restore tests, retention by data class, credential rotation,
incident response, upstream outage, stuck worker, bad migration, notification failure, correction, and rollback
runbooks. Audit history retention must honor the never-delete product requirement while complying with any
separate personal-data obligations.

### [ ] QUA-01 — Complete the quality strategy

Add:

- property tests for decimal math and reconciliation invariants;
- database integration tests using isolated PostgreSQL;
- recorded connector contract fixtures and malformed-input fuzzing;
- end-to-end worker → DB → API → UI tests;
- deterministic historical replay/golden tests across methodology versions;
- load tests for API, worker concurrency, SSE fan-out, and rate limits;
- failure-injection tests for timeouts, partial database failure, duplicate delivery, and clock skew;
- dependency, secret, static-analysis, and authorization tests.

Keep tests deterministic: inject clock, random source, fetch client, and IDs. Live public Horizon checks should
be a separate scheduled smoke suite, never a requirement for ordinary PR CI.

### [ ] REL-01 — Environments and automated releases

Create isolated development, preview, staging, and production environments; managed secrets; migration jobs;
worker and web deployment units; smoke checks; release provenance; rollback procedures; and feature flags for
new metrics/publication behavior. Promotion must be from the same tested artifact.

### [ ] REL-02 — Production-readiness gate

Before public v1:

- restore drill and incident exercise completed;
- security review and threat model findings resolved or accepted;
- methodology fixtures independently reviewed;
- anchor publication workflow legally/product reviewed;
- OpenAPI, dashboard, README, pricing, and status claims verified against production behavior;
- SLOs, on-call ownership, and rollback authority assigned;
- no planned endpoint, paid capability, or live label is presented as available unless exercised in smoke tests.

## 17. Cross-cutting security requirements

These apply from the first connector onward, not only during SEC-01:

- Treat configured and discovered URLs as SSRF boundaries. Restrict schemes, credentials, redirects, DNS/IP
  ranges, ports, response sizes, content types, and timeouts according to deployment policy.
- Keep secrets in a managed secret store; never persist or log plaintext API keys, webhook secrets, database
  URLs, or authorization headers.
- Validate every environment variable and external payload at the boundary.
- Use least-privilege database roles for migrations, workers, APIs, and audit readers.
- Escape untrusted anchor responses and evidence metadata when rendered.
- Add dependency update policy and review framework/runtime version compatibility. In particular, keep the
  Next.js runtime and ESLint configuration on a supported compatible line.
- Create a threat model covering connector egress, supply manipulation, Sybil/replica sources, audit tampering,
  key theft, notification spoofing, and denial of service.

## 18. Deferred beyond v1

Do not place these on the critical path unless product priorities change:

- WebSocket transport when SSE satisfies one-way snapshot delivery.
- Soroban/on-chain attestation or reconciliation execution.
- General third-party oracle marketplace.
- Automated financial, solvency, fraud, or regulatory conclusions; these remain out of scope permanently
  unless the product charter and legal posture are explicitly changed.
- Multi-chain support.
- Complex billing automation before API identity, quotas, and usage accounting are stable.

## 19. Immediate next five pull requests

Use this short queue to begin execution:

1. **FND-01:** synchronize with current `main`, clean generated artifacts, and establish a green baseline.
2. **FND-02:** correct stale contribution/docs claims and label all illustrative UI accurately.
3. **MTH-01:** resolve severity, lifecycle, reply-window, and publication-state contradictions in an ADR.
4. **MTH-02:** introduce validated versioned methodology configuration and changelog.
5. **MTH-03:** introduce decimal-safe Stellar amount primitives and exhaustive boundary tests.

After those five, proceed through MTH-04 and REC-01–REC-04 before expanding connectors. This avoids building
supply, DEX, and anchor pipelines on ambiguous formulas or incompatible data types.

## 20. Roadmap maintenance

- Update the baseline commit and date whenever this plan is reviewed against `main`.
- Check an item only after its acceptance criteria and CI gates pass on the merged branch.
- Add newly discovered work under the phase that owns it and declare dependencies; do not silently insert it
  into an unrelated active PR.
- When implementation changes the intended sequence, record the reason in this document and the relevant ADR.
- Review the roadmap after every completed vertical slice and before any methodology-version bump.
