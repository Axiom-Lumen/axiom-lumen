# Axiom Lumen — The Verification Layer for Stellar

[![CI](https://github.com/Axiom-Lumen/axiom-lumen/actions/workflows/ci.yml/badge.svg)](https://github.com/Axiom-Lumen/axiom-lumen/actions/workflows/ci.yml)

> **"The foundational truth that illuminates Stellar."**

Axiom Lumen is being built as a verification and intelligence layer for the Stellar ecosystem. The long-term product goal is to aggregate on-chain and off-chain data, cross-check it with published methodology, and return confidence-scored outputs with source context.

This repository currently contains a Next.js presentation surface plus one real backend vertical slice: multiple Stellar Horizon sources can be queried for their latest closed ledger, normalized, reconciled, scored, and returned through a local API route.

---

## 1. System Architecture

The intended Axiom Lumen pipeline is:

```
  [ INGEST ]              [ RECONCILE ]              [ SERVE ]
Source observations  ->  Weighted consensus       ->  JSON API responses
with timestamps          with freshness scoring       with source context
```

Implemented in this repository today:

1. **Ingest:** Latest-ledger reads from configured Horizon REST endpoints.
2. **Reconcile:** Weighted median over latest-ledger observations, half-life freshness weighting, availability-aware confidence, status classification, and discrepancy reporting.
3. **Serve:** Local Next.js API route for latest-ledger reconciliation.

Planned but not implemented yet: supply reconciliation, archive ingestion, DEX/order-book reconciliation, anchor reserve comparison, persistence, authenticated public API keys, rate limits, SSE/WebSocket streams, live dashboard wiring, and anchor right-of-reply workflows.

---

## 2. Current Implementation Status

### Implemented

- [x] **Frontend shell:** Static pages under `/`, `/about`, `/docs`, `/methodology`, `/anchors`, and `/pricing`.
- [x] **Latest-ledger Horizon connector:** Reads latest ledger records from configured Horizon endpoints.
- [x] **Latest-ledger reconciliation:** Weighted median, freshness decay, availability-aware confidence, status classification, discrepancies, and source errors.
- [x] **Local API route:** `GET /api/v1/stellar/latest-ledger`.
- [x] **Persistence foundation:** PostgreSQL schema, versioned Drizzle migrations, transactional cycle
  repositories, content-hashed evidence, and database-enforced append-only audit history.
- [x] **Tests:** Unit tests for connector/reconciliation and integration tests for the API route.
- [x] **CI:** npm-based lint, typecheck, test, integration-test, and build workflow.

### Mocked, static, planned, or missing

- [ ] **Homepage reconciliation strip:** Clearly labeled illustrative UI, not wired to the API.
- [ ] **Supply API:** Planned; no `GET /v1/supply/{asset}` implementation yet.
- [ ] **DEX/order-book depth:** Planned; no connector or reconciliation implementation yet.
- [ ] **Anchor reserve comparison:** Planned; no anchor ingestion or notification workflow yet.
- [ ] **Worker/API persistence wiring:** Repositories and audit enforcement exist, but scheduler writes and public
  persisted reads begin under ING-01 and the metric-specific API phases.
- [ ] **Authentication and rate limits:** Planned; no API key issuance or enforcement yet.
- [ ] **SSE/WebSocket streams:** Planned; not implemented.
- [ ] **Right-of-reply tooling:** Described in product documentation, but not implemented in code.

---

## 3. Implemented API

### `GET /api/v1/stellar/latest-ledger`

Configure at least one Horizon endpoint with `STELLAR_HORIZON_URLS`. The value accepts comma-separated Horizon base URLs; whitespace is trimmed and duplicate endpoints are ignored.

> This diagnostic route is pinned to the Stellar Public Network. Testnet, futurenet, standalone, and
> network-mismatched endpoints are excluded before their ledger values are requested.
>
> The connector validates each Horizon root endpoint's network passphrase before requesting ledgers. Mismatched sources are excluded and reported in `source_errors`.

For local mainnet development, use the public Stellar Horizon endpoint:

```bash
STELLAR_HORIZON_URLS="https://horizon.stellar.org" npm run dev
```

Additional endpoints may be supplied, but each must report the Public Network passphrase.
Optional `STELLAR_HORIZON_ALLOWED_HOSTS` and `STELLAR_HORIZON_DENIED_HOSTS` comma-separated lists constrain
configured hostnames. Redirects, credential-bearing URLs, and local/private literal hosts are rejected, and
Horizon response bodies are size-bounded and schema-validated.

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

- `sources_configured`: normalized Horizon endpoints accepted from `STELLAR_HORIZON_URLS` after trimming and deduplication.
- `sources_responded`: sources that returned a usable observation or an HTTP/application-level error response; request failures and aborts are not counted as responded.
- `sources_usable`: responded sources with valid latest-ledger observations used in reconciliation.
- `sources_agreeing`: usable sources within one ledger of the reconciled value.
- `sources_excluded`: configured sources rejected because their root metadata did not report the Public Network passphrase.
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

This endpoint is a live, request-time diagnostic profile. It does not read or return a persisted production
snapshot; that contract will be introduced with the persistence and ingestion roadmap items.

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
npm run build
```

PostgreSQL schema development, migration commands, isolated database tests, and the strict separation between
runtime and migration credentials are documented in [docs/database.md](./docs/database.md).

---

## 5. Methodology Notes

The broader methodology baseline is documented in [axiom-lumen-agent-guide.md](./axiom-lumen-agent-guide.md). The implemented latest-ledger slice uses a narrow v0.2 method:

- Horizon sources have equal base weight by default.
- Freshness uses a half-life model: a source loses half its vote every 30 seconds after ledger close.
- The reconciled latest ledger is the weighted median.
- Confidence includes weighted agreement, freshness, availability, expected source-class diversity, and
  normalized spread. See [the formula and worked example](./docs/reconciliation/confidence.md).
- Source request failures are not data discrepancies.

---

## 6. Development & Language Guardrails

Axiom Lumen reports measured deviations between independent data sources. It is never a solvency checker, financial advisory service, or regulatory validator.

Contributors and automated agents must follow the project tone and legal guardrails in [axiom-lumen-agent-guide.md](./axiom-lumen-agent-guide.md): factual, descriptive, timestamped, confidence-aware, and never investment advice.

The dependency-ordered remaining work is tracked in [docs/implementation-roadmap.md](./docs/implementation-roadmap.md). The older issue backlog is a historical audit and should not be used as the current implementation status.

---

## 7. License

Axiom Lumen is open-source software licensed under the Apache License 2.0. See [LICENSE](./LICENSE).
