# Methodology changelog

The public methodology is versioned independently from application releases. Changes to weights, freshness
parameters, tolerance bands, confidence formulas, or severity thresholds require a new methodology version.

## onchain-asset-supply-v0.1 — 2026-08-10

- Defined credit-asset supply as the exact sum of authorized, maintain-liabilities, and unauthorized trustline
  balances plus claimable-balance, liquidity-pool, and Stellar Asset Contract balances at one closed ledger.
- Excluded native XLM, contract tokens, economic-free-float claims, and issuer-affiliation heuristics.
- Required two genuinely independent derivations for verified status; Horizon replicas improve availability but
  do not add source diversity.
- Standardized the future public label and metric ID as “On-chain asset supply” / `onchain_asset_supply`.
- Added the `onchain-asset-supply-confidence-v0.1` formula, a 30-second freshness half-life, and a hard
  120-second maximum age that excludes old readings from current values without deleting their evidence.
- Pinned all five source-class base weights inside this methodology version so later global weight changes cannot
  alter replayed supply results.
- Added exact component-level discrepancy context for aggregate and offsetting-component mismatches.

This independently versioned metric profile does not alter the v1.5 latest-ledger weights, confidence formula,
or discrepancy policy. Decision record: [`0005-onchain-asset-supply-semantics.md`](../decisions/0005-onchain-asset-supply-semantics.md)

## v1.5 — 2026-08-09

- Published the five-component confidence formula with auditable agreement, freshness, availability,
  source-class diversity, and normalized-spread components.
- Added an explicit cap for replicas that share one declared upstream.
- Added formula/component/cap metadata to the latest-ledger response and clarified that confidence is a
  quality indicator, not a probability of correctness.

Decision record: [`0002-versioned-confidence.md`](../decisions/0002-versioned-confidence.md)

## v1.4 — 2026-08-09

- Separated measurement severity, discrepancy lifecycle, and publication state.
- Defined exact tolerance boundaries: values at or within tolerance are not discrepancies; Info is above
  tolerance through `2 × tolerance`; Warning is above `2 × tolerance` for one or two completed cycles; and
  Critical is above `2 × tolerance` for at least three completed cycles.
- Classified stale, missing, malformed, excluded, and unreachable sources as source-health outcomes rather
  than numeric discrepancies.
- Made named-party publication fail closed until the right-of-reply process and human approval complete.
- Clarified that expiry of the 72-hour reply window affects publication review, not measurement severity.
- Added executable, runtime-validated configuration for source-class weights and the implemented
  latest-ledger v0.1 profile.

Decision record: [`0001-discrepancy-severity-and-publication.md`](../decisions/0001-discrepancy-severity-and-publication.md)

## v1.3 — baseline

- Defined five source classes and their base weights.
- Specified exponential freshness decay and weighted-median reconciliation.
- Required confidence and source context on metric output.
- Established permanent discrepancy retention and a 72-hour right-of-reply window.

The v1.3 severity wording was internally inconsistent across project documents. Version 1.4 supersedes it.

## Version-bump procedure

1. Add a new immutable config module rather than editing an already-released version in place.
2. Update the exported current version and add a dated changelog entry.
3. Add or update golden methodology fixtures and configuration validation tests.
4. Synchronize the agent guide, public methodology, anchor procedure, API examples, and footer.
5. Document migrations or API compatibility consequences in an ADR when persisted output changes.
