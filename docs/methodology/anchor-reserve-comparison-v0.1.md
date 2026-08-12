# Anchor reserve comparison v0.1

## Scope

This profile compares one anchor-published reserve amount with Axiom Lumen's latest persisted on-chain asset
supply for the exact same classic credit asset. It reports a measured difference between two figures. It does
not determine redeemability, solvency, financial health, fraud, intent, or investment suitability.

No public reserve endpoint is included. ANC-03 implements notification and review controls, but results remain
non-public until the required product/legal approval and activation of a public route. ANC-04's internal
claimant and correction controls are implemented.

## Attribution

An anchor is verified through this complete chain:

1. Horizon returns the issuing account and its `home_domain`.
2. `https://{home_domain}/.well-known/stellar.toml` is retrieved without redirects through the public-HTTPS policy.
3. Exactly one `[[CURRENCIES]]` entry contains the configured asset code and issuing account.
4. That entry declares `is_asset_anchored = true` and publishes `attestation_of_reserve`.

The mutable home domain provides attribution context; it never replaces `CODE:ISSUER` as asset identity.

## Machine-readable attestation

SEP-1 defines `attestation_of_reserve` as a URL to evidence, but does not standardize a numeric response. V0.1
therefore accepts JSON only when it declares schema `axiom-lumen-anchor-reserve-attestation-v1` and contains the
exact asset and unit, decimal-safe reserve amount, and UTC period and publication timestamps.

PDFs, HTML reports, images, differently denominated currency, unversioned JSON, and inferred conversion rates
are unsupported and do not produce numeric comparisons.

## Comparison boundaries

- Attestations older than 24 hours are unavailable.
- The persisted supply reference must remain within its 120-second freshness boundary.
- Attestation period end and the exact supply ledger close time must be no more than five minutes apart.
- The inclusive tolerance is 10 basis points. Above 10 and at or below 20 basis points is Info; above 20 basis
  points enters the Warning/Critical persistence rules in methodology v1.5.
- A zero supply reference agrees only with a zero reserve amount.

Unit, scope, freshness, and period incompatibilities are source-health outcomes, not numeric discrepancies.
Anchor-published evidence is self-reported and confidence-capped; it cannot make supply verified.

The confidence formula is `min(0.50, 0.25 + supply_confidence × 0.20 + temporal_alignment × 0.05)` and the
self-reported contribution weight is `0.50`. All coefficients and the cap are executable fields in the versioned
methodology configuration.

## Security and failure behavior

Discovery and attestation URLs require HTTPS, no credentials, the standard HTTPS port, no redirects, bounded
responses, timeouts, DNS resolution exclusively to public IP addresses, and connection pinning to the validated
address set. Mismatches fail closed. Exact raw response text is content-hashed and persisted through the append-only
cycle boundary together with the supply snapshot and ledger evidence used in the comparison.

SEP-1 reference: <https://developers.stellar.org/docs/tokens/publishing-asset-info>

Decision record: [`0008-anchor-reserve-comparison-boundaries.md`](../decisions/0008-anchor-reserve-comparison-boundaries.md)
