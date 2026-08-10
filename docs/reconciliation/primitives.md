# Reconciliation primitives

Roadmap item REC-01 extracts the two lowest-level reconciliation operations into pure TypeScript modules.
They have no React, Next.js, HTTP, or persistence dependencies.

## Staleness weighting

`lib/reconcile/staleness.ts` selects the timestamp used to age an observation and applies exponential
half-life decay:

```text
effective_weight = base_weight × 0.5^(age_seconds / half_life_seconds)
```

Timestamp selection is deterministic:

1. Use the source timestamp when it is present and valid.
2. Otherwise use the retrieval timestamp.
3. Reject the observation if neither timestamp is valid.

Future timestamps are assigned age zero. Base weight and age must be finite and non-negative, and half-life
must be finite and greater than zero. The result includes the selected timestamp, whether it came from the
source or retrieval, age in seconds, and effective weight for downstream audit records.

## Weighted median

`lib/reconcile/weighted-median.ts` accepts an ID, value, and effective weight for every input. Value ordering
is delegated to a comparator, so the implementation never performs arithmetic on asset amounts.

Behavior is explicit:

- zero-weight inputs are excluded and reported in result metadata;
- negative and non-finite weights are rejected;
- IDs must be non-empty and unique;
- inputs are sorted by value and then ID, making results independent of caller order;
- the first value whose cumulative weight reaches at least half of total weight is selected;
- an exact half-weight boundary selects the lower value;
- the caller's input array is never mutated.

Convenience functions validate safe-integer values for ledgers and compare `StellarAmount` values without
converting them to JavaScript numbers.

## Compatibility

The latest-ledger worker delegates its complete reconciliation cycle to the shared orchestrator; the public route
serves the resulting finalized snapshot without contacting an upstream. Agreement, spread, and versioned confidence are documented in
[`confidence.md`](./confidence.md). Stateful severity, lifecycle, amendments, and publication safeguards are
documented in [`discrepancy-state.md`](./discrepancy-state.md).
The complete deterministic cycle composition is documented in [`orchestrator.md`](./orchestrator.md).
