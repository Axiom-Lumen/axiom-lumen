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
- [x] **Tests:** Unit tests for connector/reconciliation and integration tests for the API route.
- [x] **CI:** npm-based lint, typecheck, test, integration-test, and build workflow.

### Mocked, static, planned, or missing

- [ ] **Homepage live reconciliation strip:** Static illustrative UI, not wired to the API.
- [ ] **Supply API:** Planned; no `GET /v1/supply/{asset}` implementation yet.
- [ ] **DEX/order-book depth:** Planned; no connector or reconciliation implementation yet.
- [ ] **Anchor reserve comparison:** Planned; no anchor ingestion or notification workflow yet.
- [ ] **Persistence/audit log:** Planned; no database schema or append-only discrepancy store yet.
- [ ] **Authentication and rate limits:** Planned; no API key issuance or enforcement yet.
- [ ] **SSE/WebSocket streams:** Planned; not implemented.
- [ ] **Right-of-reply tooling:** Described in product documentation, but not implemented in code.

---

## 3. Implemented API

### `GET /api/v1/stellar/latest-ledger`

Configure at least one Horizon endpoint with `STELLAR_HORIZON_URLS`. The value accepts comma-separated Horizon base URLs; whitespace is trimmed and duplicate endpoints are ignored.

> All configured Horizon endpoints must serve the same Stellar network. Do not reconcile mainnet and testnet endpoints together.
>
> Current limitation: URL validation checks endpoint format and availability, but it does not yet prove that every endpoint serves the same Stellar network. Planned: Validate Horizon network passphrases before reconciliation.

For local mainnet development, use the public Stellar Horizon endpoint:

```bash
STELLAR_HORIZON_URLS="https://horizon.stellar.org" npm run dev
```

Additional endpoints may be supplied, but they must belong to the same Stellar network as the first endpoint.

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
  "sources_configured": 2,
  "sources_responded": 2,
  "sources_usable": 2,
  "sources_agreeing": 2,
  "observations": [],
  "discrepancies": [],
  "source_errors": [],
  "as_of": "2026-07-12T12:00:00.000Z",
  "methodology_version": "latest-ledger-v0.1"
}
```

Field semantics:

- `sources_configured`: normalized Horizon endpoints accepted from `STELLAR_HORIZON_URLS` after trimming and deduplication.
- `sources_responded`: sources that returned a usable observation or an HTTP/application-level error response; request failures and aborts are not counted as responded.
- `sources_usable`: responded sources with valid latest-ledger observations used in reconciliation.
- `sources_agreeing`: usable sources within one ledger of the reconciled value.
- `source_errors`: request failures, non-200 responses, malformed Horizon payloads, and empty records.
- `discrepancies`: usable sources that returned ledger data but disagreed with the reconciled value.
- `confidence`: 0 to 1 score based on agreement, freshness, source availability, and spread.

`status` is one of:

- `verified`: at least two usable sources agree, no source errors are present, and confidence remains high.
- `degraded`: a value is available, but availability, freshness, source count, or agreement is limited.
- `unavailable`: no usable source can produce a value.

A single usable source can return a value, but it is always `degraded` and confidence-capped so it is not presented as fully verified.

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

---

## 5. Methodology Notes

The broader methodology baseline is documented in [axiom-lumen-agent-guide.md](./axiom-lumen-agent-guide.md). The implemented latest-ledger slice uses a narrow v0.1 method:

- Horizon sources have equal base weight by default.
- Freshness uses a half-life model: a source loses half its vote every 30 seconds after ledger close.
- The reconciled latest ledger is the weighted median.
- Confidence includes agreement, freshness, and source availability.
- Source request failures are not data discrepancies.

---

## 6. Development & Language Guardrails

Axiom Lumen reports measured deviations between independent data sources. It is never a solvency checker, financial advisory service, or regulatory validator.

Contributors and automated agents must follow the project tone and legal guardrails in [axiom-lumen-agent-guide.md](./axiom-lumen-agent-guide.md): factual, descriptive, timestamped, confidence-aware, and never investment advice.

---

## 7. License

Axiom Lumen is open-source software licensed under the Apache License 2.0. See [LICENSE](./LICENSE).
