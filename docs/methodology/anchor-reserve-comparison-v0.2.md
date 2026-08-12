# Anchor reserve comparison v0.2 — Mesh mZAR profile

This immutable methodology extends anchor reserve comparison for one approved real-provider document format. It
does not replace or reinterpret `anchor-reserve-comparison-v0.1`.

## Provider and asset boundary

The profile is selected only when all of these values match:

- asset: `mZAR:GCBNWTCCMC32UHZ5OCC2PNMFDGXRVPA7MFFBFFTCVW77SX5PMRB7Q4BY`;
- verified SEP-1 home domain: `mzar.co.za`;
- attestation index: `https://mzar.co.za/`;
- connector profile: `mesh_mzar_pdf_v1`.

Any mismatch uses the generic v0.1 path or fails its own configuration checks. The provider profile cannot alter
another asset's parser, units, freshness, or discrepancy history.

## Accepted evidence

The connector accepts same-host HTTPS report links named `mZAR_Attestation_MM_YY.pdf` beneath the provider's
WordPress upload path. It selects the newest non-future report period and requires `application/pdf`. The strict
parser verifies:

- the exact Stellar issuer and the report period/filename agreement;
- mZAR issued and circulating and ZAR held for token holders, both at two decimals;
- the statement that one mZAR is redeemable for one ZAR;
- the independent-accountant report and Acredo Accounting attribution;
- the SAST report cutoff and the PDF signature timestamp, including AcroForm values.

The original index and PDF bytes are retained with SHA-256 digests. Provider layout or identity changes fail
closed as malformed or unsupported evidence.

## Comparison boundary and units

The attested ZAR reserve amount is normalized into mZAR units only under the report's explicit one-to-one
redemption assertion. This permission is specific to this profile and is not an exchange-rate facility.

The supply reference must be a persisted `onchain-asset-supply-v0.1` snapshot at an actual ledger close within
300 seconds of the report cutoff. Snapshot completion time is not a substitute for ledger-close time, and a
current supply value is never compared with a historical reserve report.

Reports may be at most 62 days past cutoff and may be signed at most 35 days after cutoff. Missing historical
supply, stale reports, future timestamps, incompatible periods, and malformed documents produce unavailable
states rather than numeric discrepancies.

## Reconciliation and publication

The inclusive tolerance is 10 basis points. Confidence uses `anchor-reserve-confidence-v0.2`: 0.25 for accepted
self-reported evidence, 0.20 for an approved supply reference, and 0.05 for temporal alignment, capped at 0.50.
The effective comparison weight is 0.50.

Discrepancy state is isolated by methodology version. All named-party results remain withheld until ANC-03
implements durable notification and human-review controls; v0.2 adds no public endpoint.
