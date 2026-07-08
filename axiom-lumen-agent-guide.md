# Axiom Lumen — Agent Reference Guide

> Read this file before working on any part of Axiom Lumen. It is the canonical source of truth for what this product is, how it must behave, and what language is and isn't allowed in anything it generates or displays. If a task conflicts with this document, this document wins — flag the conflict rather than silently resolving it.

---

## 1. What this project is

**One-liner:** Axiom Lumen is the verification and intelligence layer for the Stellar ecosystem — it aggregates on-chain and off-chain data and cross-verifies it to produce confidence-scored, defensible outputs.

**The problem it solves:** Stellar ecosystem data is fragmented across Horizon instances, archive nodes, DEX order books, anchor APIs, and external oracles, and none of these sources are required to agree with each other. Users currently have to trust one source blindly. Axiom Lumen's entire reason to exist is closing that gap.

**What it is not:** It is not a block explorer, not a price aggregator, not a wallet, and not a financial advisory service. It is an infrastructure/data layer other tools and people build on top of.

**Name etymology (keep this consistent in all copy):**
- *Axiom* — a self-evidently true, foundational statement. Represents the verification/trust pillar.
- *Lumen* — Stellar's native asset (XLM) and Latin for "light." Represents illumination/clarity.
- Combined meaning used in taglines: "The foundational truth that illuminates Stellar."

---

## 2. Brand voice (applies to all generated copy, errors, alerts, docs)

| Trait | Means | Avoid |
|---|---|---|
| Authoritative, not arrogant | Speak like a fact-checker | Don't speak like a dictator or a hype account |
| Cerebral & sharp | Precise, technical, explain complex ideas simply | No jargon-for-its-own-sake |
| Neutral & objective | Descriptive language, let data speak | No hype, no memes, no exclamation points |
| Guardian-like | The product stands between the user and bad data | Don't editorialize or moralize |

Visual identity: deep navy (`#0B1B33`) as primary, warm gold (`#D9A544`) as the "verified/clarity" accent, cyan (`#33C7E0`) as the "live/technical" accent. Display type: Fraunces (or Cambria in Office contexts). Body: IBM Plex Sans (or Calibri). Data/code: IBM Plex Mono (or Courier New).

---

## 3. System architecture (three stages — keep all new features mapped to one of these)

```
INGEST  →  RECONCILE  →  SERVE
```

1. **Ingest (Aggregation).** Real-time ingestion from every major Stellar endpoint: Horizon, Archive, path-finding, DEX/SDEX, and third-party ecosystem/anchor APIs.
2. **Reconcile (Cross-verification).** Multi-source reconciliation. Discrepancies between sources are flagged, not silently averaged away. A weighted, probabilistic reference value is computed — see Section 4.
3. **Serve (Actionable output).** Verified data exposed via REST API, WebSocket streams, and a dashboard. Every value returned carries a confidence score and its supporting/conflicting sources — see Section 5.

Any new module or endpoint should be placed in one of these three stages. If it doesn't fit, question whether it belongs in this product at all.

---

## 4. Reconciliation methodology (do not deviate without a version bump)

This is the actual product — treat changes to this logic as changes to the core product contract, not implementation details.

### 4.1 Source classification and base weights

| Source type | Example | Base weight |
|---|---|---|
| Canonical ledger state | Horizon (validator-backed core) | 1.0 |
| Archive / history nodes | Stellar Archive | 0.9 |
| DEX / order book | Horizon SDEX endpoints | 0.85 |
| Anchor self-reported | Anchor `/stats` or attestation APIs | 0.5 |
| Third-party oracle | External price feeds | 0.4 |

### 4.2 Staleness decay

```
effective_weight = base_weight × e^(−λ × age_seconds)
```
`λ` is tuned per source type: fast decay for Horizon/SDEX (seconds), slow decay for anchor attestations (hours/days).

### 4.3 Cross-source comparison

- **Agreement score** — proportion of sources within tolerance of each other.
- **Weighted median** (not mean) is the reference value — this is deliberate, so one lagging/manipulated source can't drag the published figure.

### 4.4 Discrepancy severity

| Severity | Trigger | Public treatment |
|---|---|---|
| Info | Deviation within 2x tolerance band | Logged only, not surfaced |
| Warning | Deviation beyond tolerance, <3 refresh cycles old | Surfaced with both values + timestamps |
| Critical | Deviation beyond tolerance, persists 3+ refresh cycles | Surfaced + affected party notified for right of reply |

**Discrepancies are never deleted** — even after they resolve, they remain in a permanent, timestamped audit log. This is a hard requirement, not an optimization to skip under time pressure.

### 4.5 Methodology versioning

Any change to weights, decay rates, tolerance bands, or severity thresholds requires a version bump and a changelog entry. Current version: **v1.3**.

---

## 5. API output contract

Every metric endpoint must return this shape (fields are not optional):

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

Rules for agents implementing or consuming this:
- Never return a bare value without `confidence`, `sources_total`, and `as_of`.
- `discrepancies` is always present as an array, even if empty — never omit the key.
- Timestamps are always UTC, ISO 8601.

---

## 6. Language guardrails — hard rules, not style preferences

These exist because Axiom Lumen makes factual claims about real financial entities. Violating them is a legal exposure issue, not a copy nitpick. Any agent generating UI copy, alerts, error messages, or documentation must follow these:

- **Never state a solvency, fraud, or financial-health determination about any anchor, issuer, or asset.** Axiom Lumen reports *measured deviations between published and on-chain data* — nothing more.
  - ✅ "Anchor reserves show a 2.1% variance against on-chain balance, as of 14:22 UTC."
  - ❌ "This anchor is insolvent." / "This anchor's data can't be trusted." / "This asset is at risk."
- **Never drop the confidence/source context when surfacing a number.** A number without its supporting data is exactly the "trust one source blindly" problem this product exists to fix.
- **Always give the flagged party a path to respond** before or at the time a Warning/Critical discrepancy goes public (see Section 4.4). Don't build a one-way "naming and shaming" feature.
- **No investment or financial advice language anywhere** — no "buy," "sell," "safe," "risky," "recommended." Descriptive only.
- Tone: sentence case, active voice, no exclamation points, no emoji. See Section 2.

If you (the agent) are generating a UI string, error message, alert, or doc section and you're unsure whether it crosses one of these lines, default to the more literal/descriptive phrasing and flag it for human review rather than guessing toward the punchier version.

---

## 7. Audience — design and feature decisions should serve one of these four

| Segment | What they need from the product |
|---|---|
| Stellar dApp developers | A single reliable data source to integrate into contracts/off-chain services |
| Asset issuers & anchors | Tools to monitor their own published metrics against network reality |
| Institutional traders / market makers | Verified order-book depth and asset supply before executing size |
| Ecosystem analysts | A dependable base layer for dashboards and reports on Stellar's health |

When scoping a new feature, name which of these four it serves. If it serves none of them, question whether it belongs in v1.

---

## 8. Stellar domain glossary (for agents without prior Stellar context)

- **Horizon** — Stellar's primary REST API server, the standard way to read ledger state and submit transactions.
- **Archive** — historical ledger data storage, used for verifying past states rather than current ones.
- **Anchor** — a regulated entity that issues on-chain tokens backed by real-world assets and provides fiat on/off-ramps. A common source of the "self-reported vs. on-chain" discrepancy this product is built to catch.
- **Trustline** — an explicit opt-in an account makes to hold a specific non-native asset; relevant to supply/holder calculations.
- **SDEX** — the Stellar Decentralized Exchange, built into the protocol itself (not a separate dApp).
- **Lumen (XLM)** — Stellar's native asset, required in small amounts by every account, used for fees.
- **Soroban** — Stellar's smart contract platform; relevant if/when reconciliation logic or on-chain attestations move into contracts.

---

## 9. Known open risks to keep in mind during development

- **"Axiom" is a heavily used name/trademark root** across software and fintech categories — don't assume brand exclusivity in code (e.g. package names, API namespaces) without checking current registration status.
- **The reconciliation methodology (Section 4) is the hardest engineering problem, not a solved one.** Treat weight/threshold values as configurable and tested, not hardcoded assumptions.
- **Anchor-facing features carry real legal exposure** — see Section 6. When in doubt, route through human review before shipping anchor-facing language changes.

---

## 10. Existing deliverables (for context — check before recreating)

- `axiom-lumen-landing.html` — marketing landing page, navy/gold theme
- `axiom-lumen-pitch-deck.pptx` — 8-slide pitch deck
- `axiom-lumen-methodology.docx` — published methodology & trust policy (public-facing version of Section 4 + 6 above)

Keep this guide, the methodology doc, and the landing page copy in sync — if the methodology changes, update all three.