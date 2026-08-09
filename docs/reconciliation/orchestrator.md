# Metric-agnostic reconciliation orchestrator

`lib/reconcile/orchestrator.ts` composes the pure REC-01 through REC-03 modules into one deterministic cycle.
It does not fetch data or persist results; connectors provide domain observations and a later repository layer
will atomically store its snapshot, projected discrepancy state, and append-only events.

## Pipeline

1. Parse the snapshot/cycle identifiers, subject, configured sources, observations, source errors, prior state,
   injected clock, and methodology policy.
2. Reject duplicate observations, unconfigured or mismatched sources, subject mismatches, cross-cycle readings,
   malformed prior state, and invalid methodology before returning output.
3. Keep transport, payload, network, freshness, and policy failures separate from numeric disagreement. A source
   with an error cannot contribute a value or confidence weight in that cycle.
4. Select source timestamps, compute age and half-life effective weight, and exclude zero-weight observations.
5. Use the injected metric profile for value comparison, agreement boundaries, exact deviation bands, spread
   normalization, domain-value construction, named-party attribution, and upstream identity.
6. Compute weighted median, weighted agreement, freshness, availability, expected source-class diversity,
   normalized spread, confidence, and policy caps.
7. Advance prior discrepancy state only for comparable usable observations. Missing or failed sources neither
   resolve nor escalate a numeric discrepancy.
8. Parse the complete snapshot through the shared domain schema and deeply freeze the snapshot, projected state,
   and event batch before returning them.

The clock and methodology are mandatory injected inputs and are read exactly once per cycle. Observations,
errors, states, discrepancies, and events are sorted deterministically. The same inputs, prior state, clock, and
methodology therefore serialize byte-for-byte identically. A cycle at or before a prior finalized discrepancy
cycle is rejected rather than emitting a snapshot whose values and state describe different points in time.

## Metric profiles

The orchestrator never performs arithmetic on asset amounts. A profile parses its metric-specific observation,
checks the requested subject, compares values, evaluates tolerance with the appropriate exact numeric type,
returns a bounded spread distance, and converts the reference into a domain `MetricValue`. The test profiles
exercise both safe-integer ledger sequences and values beyond JavaScript's safe integer range using
`StellarAmount`.

This profile boundary is also the compatibility seam for LED-01: the current latest-ledger route remains on its
existing adapter until that work item deliberately migrates it onto the shared orchestrator.

## Golden cases

`tests/fixtures/reconciliation/orchestrator-golden-v1.json` records the expected verified, degraded,
unavailable, stale, split-network, and asymmetric-outlier outcomes. Additional tests cover deterministic frozen
output, state resolution, all-source failure, invalid trust-boundary input, subject mismatch, invalid methodology,
out-of-order cycles, and decimal-safe amount reconciliation.
