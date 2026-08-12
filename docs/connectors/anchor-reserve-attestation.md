# Anchor reserve attestation connector

`fetchAnchorReserveObservation` reads the verified SEP-1 `attestation_of_reserve` URL registered by ANC-01. V0.1
accepts only `axiom-lumen-anchor-reserve-attestation-v1` JSON in exact issued-asset units. That generic contract
is unchanged by provider-specific profiles.

The worker compares usable evidence only with the latest persisted `onchain-asset-supply-v0.1` snapshot. It
never performs live supply collection, converts currencies, scrapes reports, or substitutes an old reference.
Incompatible scope, units, or periods become explicit unavailable states.

Evidence, attempts, source health, comparison snapshots, and discrepancy events persist atomically. The exact
approved supply snapshot, cycle, ledger checkpoint, close time, and contributing evidence identifiers are retained
with every usable reserve reading. Warning and Critical named-party discrepancies remain internal until the ANC-03
workflow durably records successful notification and activates `pending_reply`; no public route exists.

The v0.1 JSON shape is an explicit producer contract because SEP-1 does not standardize a numeric attestation
body. A discovered source is usable only when the endpoint returns that self-identifying schema; PDFs, HTML, and
unversioned payloads remain unavailable rather than being inferred or scraped.

## Mesh mZAR profile

`fetchMzarReserveObservation` is the approved provider-specific profile for the exact `mZAR` asset issued by
`GCBNWTCCMC32UHZ5OCC2PNMFDGXRVPA7MFFBFFTCVW77SX5PMRB7Q4BY`, the verified `mzar.co.za` home domain, and
`https://mzar.co.za/` attestation index. Every other issuer, domain, or endpoint continues through the generic
v0.1 contract. A partial match cannot select the mZAR parser.

The `mesh_mzar_pdf_v1` connector discovers same-host monthly PDF links, selects the latest report period that is
not in the future, retains the index and PDF evidence, and strictly verifies the report issuer, cutoff, filename,
reported token supply, ZAR reserve amount, Acredo attribution, one-to-one redemption statement, and digital
signature timestamp. PDF page text and AcroForm values are both required because the provider stores signature
dates in form fields. The PDF is parsed from a copy so the original bytes remain intact for SHA-256 hashing and
evidence persistence.

This path emits only `anchor-reserve-comparison-v0.2` / `mesh-mzar-reserve-report-v1`. Its documented one mZAR to
one ZAR policy permits the report's ZAR reserve amount to be expressed in mZAR comparison units; it is not a
general currency conversion rule. Comparison uses a persisted `onchain-asset-supply-v0.1` snapshot whose actual
ledger close is within five minutes of the report cutoff. It never substitutes the latest supply snapshot. If
that historical checkpoint is missing, the report is older than 62 days, or publication occurred more than 35
days after cutoff, the cycle is unavailable rather than numerically reconciled.

The live February 2026 provider report was used to verify interoperability and create redacted parser fixtures.
The live index currently has no newer report, so a collection performed after its 62-day cutoff window correctly
records stale evidence. ANC-02 and ANC-03 are implemented; public disclosure remains blocked on product/legal
approval and activation of the separately disabled public route. ANC-04's internal claimant and correction
controls are implemented.
