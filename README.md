# Axiom Lumen — The Verification Layer for Stellar

[![CI](https://github.com/Axiom-Lumen/axiom-lumen/actions/workflows/ci.yml/badge.svg)](https://github.com/Axiom-Lumen/axiom-lumen/actions/workflows/ci.yml)

> **"The foundational truth that illuminates Stellar."**

Axiom Lumen is being built as a verification and intelligence layer for the Stellar ecosystem. The long-term product goal is to aggregate on-chain and off-chain data, cross-check it with published methodology, and return confidence-scored outputs with source context.

This repository currently contains a Next.js presentation surface plus durable latest-ledger, on-chain supply,
classic SDEX depth, and trustline-state pipelines. A background worker collects registered sources, reconciles and persists their
evidence, and the public APIs serve finalized snapshots only.

---

## 1. System Architecture

The intended Axiom Lumen pipeline is:

```
  [ INGEST ]              [ RECONCILE ]              [ SERVE ]
Source observations  ->  Weighted consensus       ->  JSON API responses
with timestamps          with freshness scoring       with source context
```

Implemented in this repository today:

1. **Ingest:** An idempotent leased worker reads registered Horizon REST endpoints with bounded concurrency,
   retries transient failures, and persists source health and circuit state.
2. **Reconcile:** Metric-specific weighted reconciliation with freshness, availability, source-diversity,
   confidence, status classification, and discrepancy reporting.
3. **Serve:** A local Next.js API route reads the latest finalized PostgreSQL snapshot without live upstream work.

Planned but not implemented yet: public anchor reserve disclosure, authenticated public API keys, rate limits,
SSE/WebSocket streams, and anchor right-of-reply workflows.

---

## 2. Current Implementation Status

### Implemented

- [x] **Frontend shell:** Public pages under `/`, `/dashboard`, `/about`, `/docs`, `/methodology`, `/anchors`, and `/pricing`.
- [x] **Homepage reconciliation strip:** Server-rendered persisted supply snapshot with validated periodic refresh and explicit failure states.
- [x] **Reconciliation dashboard:** API-derived supply status, confidence explanation, source context, failures, and current-snapshot publication-approved discrepancy intervals.
- [x] **Latest-ledger Horizon connector:** Reads latest ledger records from configured Horizon endpoints.
- [x] **Latest-ledger reconciliation:** Weighted median, freshness decay, availability-aware confidence, status classification, discrepancies, and source errors.
- [x] **Local API route:** `GET /api/v1/stellar/latest-ledger`.
- [x] **Persistence foundation:** PostgreSQL schema, versioned Drizzle migrations, transactional cycle
  repositories, content-hashed evidence, and database-enforced append-only audit history.
- [x] **Background ingestion:** Database source discovery, deterministic cycles, leases/heartbeats, bounded
  concurrency, cancellation, graceful shutdown, abandoned-lease recovery, and idempotent finalization.
- [x] **Source resilience:** Per-request timeouts and payload limits, retry budgets with bounded jitter and
  `Retry-After`, per-job source concurrency, circuit breakers, and persisted health transitions.
- [x] **Supply specification:** The approved on-chain asset-supply formula defines ledger-consistency rules,
  replica-independence policy, and truthful public naming.
- [x] **Horizon supply connector:** Collects bounded, resumable, same-ledger classic-credit-asset totals with
  exact decimal arithmetic and structured failures.
- [x] **Independent supply evidence:** Validates recorded history-archive state-replay artifacts against trusted
  checkpoint metadata and normalizes them with Horizon readings through one raw observation contract.
- [x] **Persisted supply reconciliation:** Discovers explicitly configured credit assets, runs Horizon and
  independently trusted archive derivations, excludes stale evidence, and atomically stores raw readings,
  snapshots, source health, discrepancies, and events with idempotent cycle replay.
- [x] **SDEX depth ingestion foundation:** Defines canonical pair, price, and band semantics and collects
  bounded, same-ledger classic-offer depth with exact rational arithmetic.
- [x] **Persisted SDEX depth:** Discovers explicitly routed pairs, persists coherent six-bucket books, reconciles
  complete source observations, and serves `GET /api/v1/depth/{pair}` with freshness enforcement.
- [x] **Trustline state:** Publishes exact authorization-state counts and their total at
  `GET /api/v1/trustlines/{asset}` without presenting trustlines as funded holders or users.
- [x] **Internal anchor reserve comparison:** Verifies issuer-to-domain attribution through SEP-1, ingests the
  generic strict exact-unit contract, and includes an isolated real-provider mZAR PDF profile matched to a
  historical supply ledger close. Named-party results remain behind the reply/review publication gate; no public
  reserve endpoint exists yet.
- [x] **Anchor right-of-reply case workflow:** Eligible named-party reserve discrepancies create deterministic
  internal cases; leased email/webhook notifications use bounded delivery, signed webhooks, encrypted rotatable
  secrets, and append-only audits. Failed delivery remains internal, the 72-hour clock begins after first
  successful notice, and scoped human review remains behind a separately disabled publication gate.
- [x] **Verified anchor claimant workflow:** Operators can issue single-use SEP-1 domain challenges, establish
  expiring claimant sessions, register same-domain contacts, accept immutable versioned replies and flag-ID
  disputes, scan uploads before storage, and append reviewed corrections or retractions. The public read model
  excludes secrets and unclean evidence and renders claimant text without raw HTML.
- [x] **Persisted latest-ledger reads:** The public route serves finalized snapshots and never waits on Horizon.
- [x] **Persisted supply reads:** `GET /api/v1/supply/{asset}` serves the latest finalized Public Network
  credit-asset snapshot and fails closed when that snapshot is older than the methodology's freshness bound.
- [x] **Tests:** Unit tests for connector/reconciliation and integration tests for the API route.
- [x] **CI:** npm-based lint, typecheck, test, integration-test, and build workflow.

### Mocked, static, planned, or missing

- [ ] **Public anchor reserve endpoint:** Comparison, notification, review, claimant, dispute, and correction
  controls exist internally; the externally served reserve endpoint remains disabled.
- [ ] **Authentication and rate limits:** Planned; no API key issuance or enforcement yet.
- [ ] **SSE/WebSocket streams:** Planned; not implemented.
- [ ] **Self-service claimant surface:** The authenticated operator workflow is implemented, but no public web
  form or claimant API is enabled.

---

## 3. Implemented API

### `GET /api/v1/stellar/latest-ledger`

Register at least one enabled Public Network Horizon source in PostgreSQL and run the ingestion worker. See
[the worker guide](./docs/worker.md) for migrations, source registration, and commands.

> This diagnostic route is pinned to the Stellar Public Network. Testnet, futurenet, standalone, and
> network-mismatched endpoints are excluded before their ledger values are requested.
>
> The connector validates each Horizon root endpoint's network passphrase before requesting ledgers. Mismatched sources are excluded and reported in `source_errors`.

Run one collection cycle before starting or querying the web process:

```bash
npm run worker:once
npm run dev
```

Additional database sources may be registered, but each must report the configured network passphrase. Optional
`STELLAR_HORIZON_ALLOWED_HOSTS` and `STELLAR_HORIZON_DENIED_HOSTS` lists constrain discovered hostnames.
Redirects, credential-bearing URLs, local/private literal hosts, oversized bodies, and malformed payloads are
rejected by the worker.

Then request the local endpoint:

```bash
curl http://localhost:3000/api/v1/stellar/latest-ledger
```

Response fields include:

```json
{
  "metric": "latest_ledger",
  "value": 54891234,
  "status": "verified",
  "confidence": 0.97,
  "confidence_formula_version": "latest-ledger-confidence-v0.2",
  "confidence_components": {
    "agreement": 1,
    "freshness": 0.88,
    "availability": 1,
    "diversity": 1,
    "spread": 1
  },
  "confidence_caps_applied": [],
  "sources_configured": 2,
  "sources_responded": 2,
  "sources_usable": 2,
  "sources_agreeing": 2,
  "sources_excluded": 0,
  "observations": [],
  "discrepancies": [],
  "source_errors": [],
  "as_of": "2026-07-12T12:00:00.000Z",
  "methodology_version": "latest-ledger-v0.2"
}
```

Field semantics:

- `sources_configured`: enabled sources discovered for the snapshot's network and metric.
- `sources_responded`: sources that returned a usable observation or an HTTP/application-level error response; request failures and aborts are not counted as responded.
- `sources_usable`: responded sources with valid latest-ledger observations used in reconciliation.
- `sources_agreeing`: usable sources within one ledger of the reconciled value.
- `sources_excluded`: configured sources omitted by policy, including network mismatch or an open circuit.
- `source_errors`: request failures, non-200 responses, malformed Horizon payloads, empty records, and network mismatches.
- `discrepancies`: usable sources that returned ledger data but disagreed with the reconciled value.
- `confidence`: a bounded quality indicator based on agreement, freshness, source availability, source-class
  diversity, and spread; it is not a probability of correctness.
- `confidence_formula_version`, `confidence_components`, and `confidence_caps_applied`: audit metadata explaining
  which formula produced the score and which policy constraints lowered it.

`status` is one of:

- `verified`: at least two usable sources agree, no source errors are present, and confidence remains high.
- `degraded`: a value is available, but availability, freshness, source count, or agreement is limited.
- `unavailable`: no usable source can produce a value.

A single usable source can return a value, but it is always `degraded` and confidence-capped so it is not presented as fully verified.

This endpoint reads the latest finalized persisted snapshot. It never fans out to Horizon or waits for a live
collection cycle. If no finalized snapshot exists, it returns the shared error envelope with `404`.

### `GET /api/v1/supply/{asset}`

Provide the canonical classic credit-asset identifier as `CODE:ISSUER` (URL-encoded when required):

```bash
curl "http://localhost:3000/api/v1/supply/USDC:G..."
```

The route returns the shared v1 snapshot contract with `onchain_asset_supply`, a decimal-string amount,
confidence components and caps, source counts and contributions, approved-public discrepancies, structured
source errors, UTC `as_of`, and `onchain-asset-supply-v0.1`. It reads PostgreSQL only. Missing snapshots return
`404`; malformed or native assets return `400`; persisted unavailable or expired snapshots return `503`.

The endpoint is currently pinned to the Public Network. Once the age already recorded for any contributing
observation plus elapsed time exceeds 120 seconds, the response becomes explicitly `unavailable`, clears its
current value/contributions, and records a `stale_observation` error while preserving the original snapshot
`as_of`.

### `GET /api/v1/depth/{pair}`

Returns one coherent classic-offer depth book for canonical `BASE~COUNTER`, with bid and ask cumulative depth at
50, 100, and 500 basis points around an exact midpoint. Reversed pair identifiers resolve to the canonical
subject. Liquidity pools remain excluded, and Horizon-only evidence is confidence-capped as degraded.

### `GET /api/v1/trustlines/{asset}`

Returns exact `authorized`, `authorized_to_maintain_liabilities`, and `unauthorized` trustline counts plus their
sum for a classic `CODE:ISSUER` asset. This is trustline authorization state—not funded holders, wallet users, or
beneficial owners. Native XLM is unsupported because it has no trustline.

### Shared HTTP behavior

`/api/v1` is the canonical public prefix. All four implemented routes accept `GET` and `OPTIONS`, echo or generate
`X-Request-ID`, expose public read-only CORS, reject undeclared query parameters, and return a shared error
envelope for invalid requests, unsupported methods, missing snapshots, and read-store failures. Current `200`
snapshots use private, request-ID-varying caches and complete-representation weak ETags; errors and unavailable
responses use `Cache-Control: no-store`. Matching `If-None-Match` requests return `304`.

Each route caps caching at its remaining evidence lifetime. Supply uses at most 15 seconds plus 45 seconds of
stale-while-revalidate, depth uses 5 plus 15 seconds, and trustline state uses 60 plus 300 seconds.

Shared cursor pagination defaults to 25 and is capped at 100 for future list endpoints. The current snapshot
routes are singular resources and reject pagination parameters. Deprecation headers are emitted only when a route
has an explicit sunset policy. See [ADR 0006](./docs/decisions/0006-public-http-api-policy.md).

The generated production OpenAPI 3.1 contract is available at
[`openapi/openapi.json`](./openapi/openapi.json). Run `npm run openapi:generate` after public contract changes and
`npm run openapi:check` to detect drift. The production paths include implemented routes only; see the
[OpenAPI workflow](./docs/openapi.md).

The confidence artifact on the homepage, documentation, and methodology pages fetches the persisted supply API
on the server and validates the response before rendering it as live. Set `AXIOM_DEFAULT_ASSET` to a canonical
`CODE:ISSUER` watched by the worker; it defaults to Public Network USDC. Empty, stale, unavailable, and invalid
responses are explicitly labeled and are never presented as current verified data.

---

## 4. Local Development

### Prerequisites

- Node.js 22.x or later
- npm, using the tracked `package-lock.json`

### Getting Started

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the application.

Run the same checks as CI:

```bash
npm run ci
```

Useful individual checks:

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:database
npm run build
```

Production builds use Next.js's supported webpack builder. This avoids Turbopack's internal CSS worker port
binding, which is unavailable in restricted build environments; local development continues to use the default
Next.js development builder.

PostgreSQL schema development, migration commands, isolated database tests, and the strict separation between
runtime and migration credentials are documented in [docs/database.md](./docs/database.md).
Worker source setup, one-shot/continuous execution, configuration, and lease recovery are documented in
[docs/worker.md](./docs/worker.md).

The internal claimant and correction operator flow is documented in
[docs/anchor-claim-workflow.md](./docs/anchor-claim-workflow.md).

---

## 5. Methodology Notes

The broader methodology baseline is documented in [axiom-lumen-agent-guide.md](./axiom-lumen-agent-guide.md). The implemented latest-ledger slice uses a narrow v0.2 method:

- Horizon sources have equal base weight by default.
- Freshness uses a half-life model: a source loses half its vote every 30 seconds after ledger close.
- The reconciled latest ledger is the weighted median.
- Confidence includes weighted agreement, freshness, availability, expected source-class diversity, and
  normalized spread. See [the formula and worked example](./docs/reconciliation/confidence.md).
- Source request failures are not data discrepancies.

The implemented credit-asset reconciliation metric is defined as
[On-chain asset supply v0.1](./docs/methodology/onchain-asset-supply-v0.1.md). It includes every ledger balance
container at one closed ledger and deliberately does not claim to measure economic free float or native XLM.

The implemented SDEX ingestion profile is defined as
[Order-book depth v0.1](./docs/methodology/order-book-depth-v0.1.md). It covers exact classic-offer depth only;
liquidity pools remain excluded. Persisted reconciliation and the public endpoint are defined by
[order-book depth v0.2](./docs/methodology/order-book-depth-v0.2.md).

---

## 6. Development & Language Guardrails

Axiom Lumen reports measured deviations between independent data sources. It is never a solvency checker, financial advisory service, or regulatory validator.

Contributors and automated agents must follow the project tone and legal guardrails in [axiom-lumen-agent-guide.md](./axiom-lumen-agent-guide.md): factual, descriptive, timestamped, confidence-aware, and never investment advice.

Broad product direction is described in the [public roadmap](./docs/implementation-roadmap.md). Detailed sequencing and internal acceptance criteria are maintained privately. The older issue backlog is a historical audit and should not be used as the current implementation status.

---

## 7. License

Axiom Lumen is open-source software licensed under the Apache License 2.0. See [LICENSE](./LICENSE).
