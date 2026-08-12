# ADR 0008: Define anchor reserve comparison boundaries

- Status: Accepted
- Date: 2026-08-11
- Metric profile: `anchor-reserve-comparison-v0.1`
- Owners: engineering and methodology

## Context

SEP-1 lets an issuer publish an `attestation_of_reserve` URL but does not standardize a numeric response,
accounting scope, denomination, or reporting period. Comparing an arbitrary report with current ledger supply
would create false discrepancies. Anchor evidence is also a named party's self-report and cannot independently
verify the ledger-derived supply metric.

## Decision

V0.1 accepts only the documented `axiom-lumen-anchor-reserve-attestation-v1` producer contract. The payload must
identify the exact classic credit asset and express its reserve amount in that asset's units. No currency
conversion, report scraping, or inferred unit mapping is permitted. Unsupported documents remain unavailable.

The comparison uses only `onchain-asset-supply-v0.1` and retains the exact supply snapshot, cycle, ledger sequence,
ledger close time, and contributing evidence identifiers. The attestation period end and supply ledger close time
must be within five minutes. The supply ledger evidence must be no older than 120 seconds and the attestation no
older than 24 hours at collection.

The v0.1 inclusive tolerance is 10 basis points. Differences above 10 through 20 basis points are Info; differences
above 20 basis points enter the v1.5 Warning/Critical persistence rules. This is a narrow operational comparison
band, not an accounting materiality or solvency threshold. Changing it requires a new metric profile.

Confidence is:

```text
min(0.50, 0.25 + supply_confidence × 0.20 + temporal_alignment × 0.05)
```

The reserve contribution weight is 0.50, matching the v1.5 `anchor_self_reported` source-class weight. The cap
ensures a self-report cannot make the supply result verified. Every coefficient is executable configuration.

Issuer-to-domain verification expires after 24 hours. A route is schedulable only while its per-asset binding is
current. Re-verification appends an immutable event; endpoint or home-domain rotation supersedes the old binding;
failed re-verification suspends it.

Named-party Warning or Critical measurements remain internal. Only the future ANC-03 notification transaction may
start `pending_reply` and the 72-hour clock. No public reserve route exists before that workflow is approved.

## Consequences

- Existing PDF, HTML, image, or unversioned JSON reports do not produce a number.
- Provider adoption of the producer contract is required before a discovered endpoint becomes usable.
- Unit, scope, methodology, freshness, or period mismatch produces `unavailable`, never a numeric discrepancy.
- Raw attestation text and exact supply-reference provenance remain available for replay and human review.

## Alternatives rejected

- **Scrape arbitrary attestations:** report layouts and accounting scopes are not machine-stable.
- **Convert fiat values into issued-asset units:** this introduces an unapproved price source and time boundary.
- **Compare with the latest cycle completion time:** completion time is not the ledger measurement boundary.
- **Treat anchor evidence as independent verification:** the value is supplied by the affected named party.

## References

- [Anchor reserve comparison methodology](../methodology/anchor-reserve-comparison-v0.1.md)
- [Discrepancy severity and publication ADR](0001-discrepancy-severity-and-publication.md)
- [On-chain asset supply ADR](0005-onchain-asset-supply-semantics.md)
