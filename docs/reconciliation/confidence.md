# Agreement, spread, and confidence

Confidence is a bounded quality indicator for a reconciliation result. It is **not** a probability that the
result is correct. Every result identifies the formula version, component values, and policy caps that affected
the final score.

## Components

All components are finite numbers in `[0, 1]`, where a larger value means stronger evidence.

- **Agreement (`A`)** is agreeing effective weight divided by total effective weight. Fresh but low-authority
  sources therefore cannot outvote stronger evidence merely by source count.
- **Freshness (`F`)** is total effective weight after decay divided by total undecayed base weight.
- **Availability (`V`)** is usable sources divided by configured sources.
- **Diversity (`D`)** is represented expected source classes divided by all expected source classes. Repeated
  observations from one class do not increase this component.
- **Spread (`S`)** is `1 - min(1, max(|observation - reference|) / maximumSpread)`. It reaches zero at and beyond
  the configured maximum spread.

## Formula

`latest-ledger-confidence-v0.2` uses:

```text
evidence = 0.50A + 0.25F + 0.20V + 0.05S
uncapped confidence = evidence × D
confidence = min(uncapped confidence, every applicable policy cap)
```

Diversity is multiplicative: replicas can strengthen agreement only when the expected independent source
classes are actually represented. The latest-ledger profile expects the `canonical_ledger` class, so its class
diversity is complete when at least one usable canonical-ledger observation exists.

Policy caps are applied after the formula. The current latest-ledger caps are `0.60` for one usable source,
`0.70` for multiple replicas sharing one declared upstream, and `0.85` when a source error is present. A cap is
reported only when it lowers the result. Source identifiers default to independent upstreams; connectors must
set the same `upstreamId` when endpoints replicate one underlying provider.

## Worked example

For `A = 0.80`, `F = 0.90`, `V = 0.75`, `D = 0.50`, and `S = 0.60`:

```text
evidence = (0.50 × 0.80) + (0.25 × 0.90) + (0.20 × 0.75) + (0.05 × 0.60)
         = 0.805
confidence = 0.805 × 0.50
           = 0.4025
```

No claim of “40.25% probability of correctness” follows from this score. It communicates the strength,
coverage, independence, freshness, and consistency of the evidence under this named formula.
