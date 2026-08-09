# ADR 0002: Versioned confidence composition and replica caps

- Status: Accepted
- Date: 2026-08-09
- Methodology impact: v1.4 → v1.5

## Context

The previous latest-ledger implementation combined agreement, freshness, availability, and spread inline. It
did not expose component values, model expected source-class coverage, or distinguish independent upstreams
from replicated endpoints. That made the score harder to audit and allowed endpoint count to be mistaken for
evidence diversity.

## Decision

Methodology v1.5 publishes `latest-ledger-confidence-v0.2`. The weighted evidence score combines agreement,
freshness, availability, and normalized spread, then multiplies that score by expected source-class coverage.
Applicable policy caps are applied afterward and returned with the formula version and all component values.

Multiple observations declaring the same `upstreamId` are capped at `0.70`; one usable source is capped at
`0.60`; and a source error caps confidence at `0.85`. Source-class diversity counts unique expected classes,
not endpoints. Confidence remains a bounded evidence-quality indicator and is not a probability of correctness.

## Consequences

- Consumers can explain and reproduce a score from response metadata.
- Replicas cannot claim additional class diversity and declared same-upstream replicas cannot reach verified
  confidence.
- The additive response metadata is backward-compatible, but the methodology and confidence-formula versions
  change so consumers can distinguish results produced under the new policy.
- Methodology v1.4 remains available as an immutable configuration module for replay.
