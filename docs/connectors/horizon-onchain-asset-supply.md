# Horizon on-chain asset-supply connector

`fetchHorizonOnchainAssetSupply` implements the Horizon derivation of
`onchain-asset-supply-v0.1` for one classic credit asset. SUP-04 registers its shared raw-observation wrapper
with the background worker and atomically persists its evidence with reconciliation output.

## Collection sequence

1. Validate the classic `CODE:ISSUER` asset, network identity, endpoint policy, and scan budgets.
2. Read Horizon's root and require the configured network passphrase.
3. Read the issuer account, require a valid `Latest-Ledger`, and fail distinctly when it is missing.
4. Query `/assets` for the exact code and issuer, follow only same-origin links that preserve that identity,
   and require one `Latest-Ledger` value across every page.
5. Require exactly one complete asset record, parse all six approved components as `StellarAmount`, and add
   their stroop values without floating-point conversion.
6. Read `/ledgers/{sequence}` and use its close time as the observation's source timestamp.

Successful observations retain the network and asset identity, normalized amount, exact component strings,
ledger sequence and close time, retrieval timestamps, connector/methodology/derivation versions, page and
cursor metadata, and SHA-256 digests for every successful response payload. Horizon replicas all use the
`horizon_asset_aggregate` derivation family and therefore do not become independent evidence by changing host.

The issuer request proves that the exact issuer account exists and records its request ledger. Its unverified
`home_domain` claim is deliberately omitted. The approved SSRF-safe `stellar.toml` verification and attribution
workflow is a later ANC-01 concern.

## Checkpoints and bounds

The versioned checkpoint is plain JSON and can be persisted by the caller after a structured failure. It
contains the next validated URL, ledger fence, completed page and record counts, seen page URLs and paging
tokens, the exact record (when found), issuer request context, and request provenance. Resumption validates
the checkpoint's cross-field invariants as well as its source, asset, network, page size, and endpoint policy
before issuing a request, then continues without repeating completed pages.

Defaults are 200 records per page, 100 pages, 1,000 records, the shared five-second request timeout, and the
shared one-megabyte response limit. Exhausting page or record bounds returns `partial_scan`; a partial total is
never emitted. A mid-scan ledger change automatically restarts from the beginning once by default and reports
`ledger_changed` without an unsafe checkpoint when the configurable restart bound is exhausted. Repeated
pages or records require a caller-initiated clean restart.

## Structured failure codes

The adapter returns a discriminated result instead of throwing for expected source failures:

- `invalid_asset`, `invalid_configuration`, `network_mismatch`
- `issuer_not_found`, `asset_not_found`
- `request_failed`, `request_aborted`, `non_200_response`, `redirect_rejected`
- `response_too_large`, `malformed_payload`
- `partial_scan`, `ledger_changed`, `duplicate_record`

HTTP errors retain status and parsed `Retry-After` delay where available. Retriable page failures include a
checkpoint; ledger drift and duplicate pagination set `restartRequired` because their partial state is unsafe.
