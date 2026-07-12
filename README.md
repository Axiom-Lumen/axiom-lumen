# Axiom Lumen — The Verification Layer for Stellar

[![CI](https://github.com/testersweb0-bug/axiom-lumen/actions/workflows/ci.yml/badge.svg)](https://github.com/testersweb0-bug/axiom-lumen/actions/workflows/ci.yml)

> **"The foundational truth that illuminates Stellar."**

Axiom Lumen is the verification and intelligence layer for the Stellar ecosystem. It aggregates on-chain and off-chain data—including Horizon endpoints, full-history Stellar Archive nodes, DEX order-book depth, and self-reported anchor stats—and cross-verifies them using mathematical models to produce a unified, confidence-scored reference value.

By building on top of Axiom Lumen, developers, institutional market makers, and ecosystem analysts get a single, defensible source of truth instead of having to reconcile conflicting API data streams manually.

---

## 1. System Architecture

The core of Axiom Lumen is structured around a three-stage data pipeline:

```
  [ INGEST ]              [ RECONCILE ]              [ SERVE ]
Aggregates raw        Weighted median, staleness     JSON API, SSE stream,
source streams   →   decay, agreement & confidence  →  interactive dashboard
(Horizon/DEX/TOML)   scoring (Methodology v1.3)      & verified status logs
```

1. **Ingest (Aggregation):** Continuous real-time ingestion from Horizon API, full-history archive storage, DEX order books, and SEP-0001 `stellar.toml` self-reported statistics.
2. **Reconcile (Cross-verification):** Evaluates observations using source-class base weights, applies time-decay models, and computes a **weighted median** (instead of a weighted mean) to neutralize outlier manipulation or endpoint lag.
3. **Serve (Actionable Output):** Exposes clean JSON payloads over REST and SSE/WebSockets, decorated with metadata (timestamp, methodology version, agreeing source ratio) and a confidence score between `0.0` and `1.0`.

---

## 2. Current Implementation Status

This repository currently contains the **high-fidelity presentation and marketing surface** built using Next.js 16 (App Router), styled with vanilla CSS. 

### Status Checklist

- [x] **Frontend Shell:** Polished, theme-compliant pages (`/`, `/about`, `/docs`, `/methodology`, `/anchors`)
- [x] **Responsive Navigation:** Interactive layouts, header menu, and structured document colophons
- [x] **Layout & Assets:** Customized branding with `/logo.png` and high-resolution `/icon.png` favicon config
- [ ] **Reconciliation Engine:** TypeScript mathematical engine (weighted median, staleness, confidence)
- [ ] **Data Ingestion Worker:** Standalone scheduler, connectors, and health monitoring
- [ ] **Persistence Layer:** Database schema, migrations, and append-only discrepancy logs
- [ ] **Public API routes:** Authenticated REST endpoints (e.g. `GET /v1/supply/{asset}`)
- [ ] **Anchor claim & reply portals:** Signed TOML verification, 72-hour Warning grace-period queues, and dispute forms

### Target API Response Specification
All supply endpoints will expose the following unified JSON payload contract:
```json
{
  "metric": "circulating_supply",
  "asset": "USDC:GA5Z...",
  "value": "48213092.44",
  "confidence": 0.94,
  "sources_agreeing": 4,
  "sources_total": 5,
  "discrepancies": [
    {
      "source": "anchor_api",
      "delta_pct": 0.03,
      "severity": "info"
    }
  ],
  "as_of": "2026-07-06T14:22:01Z"
}
```

---

## 3. Local Development

### Prerequisites
* **Node.js** 20.x or later
* **npm** or **pnpm** package manager

### Getting Started
1. Clone the repository and navigate to the project directory:
   ```bash
   cd axiom-lumen
   ```
2. Install local development dependencies:
   ```bash
   npm install
   ```
3. Run the hot-reloading Next.js development server:
   ```bash
   npm run dev
   ```
4. Open [http://localhost:3000](http://localhost:3000) to view the application.

---

## 4. Methodology Core Parameters (v1.3 Baseline)

* **Source Classification Weights:**
  * Canonical core state (Horizon): `1.0`
  * Archive/history nodes: `0.9`
  * DEX/SDEX order-books: `0.85`
  * Self-reported anchor APIs: `0.5`
  * Third-party feeds/oracles: `0.4`
* **Staleness Decay Formula:**
  $$\text{effective\_weight} = \text{base\_weight} \times e^{(-\lambda \times \text{age\_seconds})}$$
* **Discrepancy Severity:**
  * **Info:** Deviation within $2 \times$ tolerance band. Logged internally, not surfaced publicly.
  * **Warning:** Deviation beyond tolerance, under 3 cycles old. Surfaced on status feeds with source timestamps.
  * **Critical:** Persistent deviation beyond tolerance (3+ cycles). Surfaced publicly and triggers the 72-hour right-of-reply window for anchors.

---

## 5. Development & Language Guardrails

> [!IMPORTANT]
> Axiom Lumen reports **measured deviations** between independent data sources. It is **never** a solvency checker, financial advisory service, or regulatory validator.

All developers and automated agents contributing code, copy, or documentation to this repository must strictly adhere to the project's legal and tone guidelines in [axiom-lumen-agent-guide.md](file:///home/c-shells/Desktop/Projects/axiom-lumen/axiom-lumen-agent-guide.md):
* **Factual & Descriptive:** State facts and differences (e.g. *"variance of 2.1% observed"*), never judgements (*"insolvent"*, *"untrustworthy"*, *"scam"*).
* **Context Preservation:** Always include source context, confidence levels, and timestamps when outputting calculations.
* **Objective Voice:** Use sentence case, neutral, active voice. Do not use exclamation points, emojis, or sensationalist headlines.
* **No Financial Advice:** Never use speculative investment terms or advise actions like buying, selling, or evaluating safety.

---

## 6. License
Axiom Lumen is open-source software licensed under the **Apache License 2.0**. See the upcoming `LICENSE` and `NOTICE` files for copyright details and attributions.
