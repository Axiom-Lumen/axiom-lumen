# ADR 0009: Add an isolated retrospective Mesh mZAR reserve profile

- Status: accepted
- Date: 2026-08-11

## Context

SEP-1 identifies an attestation URL but does not standardize its payload. The generic ANC-02 v0.1 connector
therefore cannot consume Mesh Trade South Africa's monthly PDF reports. Those reports describe a historical
month-end cutoff, ZAR reserves, mZAR supply, a one-to-one redemption policy, and signature dates stored partly in
PDF form fields. Comparing them with the latest on-chain supply would create a false period match.

## Decision

Add `mesh_mzar_pdf_v1` and `anchor-reserve-comparison-v0.2` as an exact provider/asset profile. Route it only for
the verified mZAR issuer, `mzar.co.za`, and normalized attestation index. Keep v0.1 unchanged for every generic
anchor.

Parse the latest non-future monthly report strictly, preserve its original evidence bytes, and normalize ZAR to
mZAR only when the approved document contains the explicit one-to-one redemption statement. Compare only with a
persisted supply snapshot whose actual ledger close is within five minutes of the report cutoff. Do not fall back
to current supply. Isolate discrepancy state by methodology version and retain the existing publication gate.

## Consequences

The real provider is interoperable without weakening the generic producer contract or inventing cross-provider
PDF semantics. Historical supply snapshots must already exist in the durable supply pipeline; their absence is an
explicit unavailable result. Stale provider publication also remains visible as source health rather than being
silently reused. Additional providers require their own reviewed profile and methodology version.
