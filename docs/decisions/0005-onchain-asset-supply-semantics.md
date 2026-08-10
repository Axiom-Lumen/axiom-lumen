# ADR 0005: Define on-chain asset supply and evidence independence

- Status: Proposed — awaiting product/methodology approval
- Date: 2026-08-10
- Metric profile: `onchain-asset-supply-v0.1`
- Owners: engineering and methodology; approval of this ADR/PR changes the status to Accepted

## Context

“Circulating supply” can mean issued units, economically transferable units, or free float after balances
controlled by an issuer are removed. Stellar does not encode beneficial ownership or issuer affiliation, so a
ledger-only connector cannot establish economic free float. Calling a raw trustline sum “circulating supply”
would also omit units held in claimable balances, liquidity pools, and Stellar Asset Contract storage.

The existing domain discriminator is `circulating_supply`, but no supply endpoint is implemented. This decision
therefore fixes the measured scope and truthful public label before a connector or public contract exists.

## Decision

The v0.1 metric is **On-chain asset supply** for a classic Stellar credit asset identified by `CODE:ISSUER`.
It measures all outstanding units represented by the canonical ledger at one closed-ledger boundary. It does
not claim to measure economic free float, redeemability, backing, solvency, or units controlled by related
parties.

For asset `A` at closed ledger `L`:

```text
on_chain_asset_supply(A, L) =
    authorized_trustline_balances
  + maintain_liabilities_trustline_balances
  + unauthorized_trustline_balances
  + claimable_balance_amount
  + liquidity_pool_amount
  + contract_balance_amount
```

All terms are non-negative stroop-scaled integers and are summed without conversion through JavaScript
`number`. Liabilities are constraints on balances and are not added again. Sponsorship changes who funds a
reserve, not who owns the asset, and does not change the formula. The issuer has no holder balance for its own
classic asset: transfers from the issuer mint units, while transfers to the issuer and clawbacks burn units.

Authorization state affects transferability, not whether units remain outstanding, so every authorization
bucket is included. Claimable balances are counted once regardless of claimant count. Liquidity-pool reserves
are counted as the underlying asset; pool-share trustlines are not counted as that asset. Contract-held balances
of the asset’s built-in Stellar Asset Contract are the same asset and are included.

Native XLM is unsupported by this profile. Its circulating definition depends on the fee pool and policy-managed
account sets such as the SDF mandate and upgrade reserve. It requires a separately versioned native-supply
decision and cannot be inferred by applying the credit-asset formula. Contract tokens issued by `C...` contracts
are likewise outside v0.1.

The canonical future route remains `GET /api/v1/supply/{asset}` because “supply” is scope-neutral. Its public
metric ID is `onchain_asset_supply`. Public copy must say “On-chain asset supply” and carry
`onchain-asset-supply-v0.1`. The current internal `circulating_supply` domain discriminator is retained only for
pre-API compatibility and is not an economic-free-float claim.

Network, code, and issuer account are the asset identity. An issuer account’s mutable `home_domain` and its
`stellar.toml` may provide attribution context but cannot replace the issuer key or change the total. Provenance
must record how and when a home domain was obtained, validate it through the approved metadata-discovery path,
and fail closed before attributing a self-report to a named organization.

## Ledger consistency and completeness

Every component in one observation must come from one complete source representation at the same closed ledger.
For Horizon, the connector must require and persist the `Latest-Ledger` response header. It must request the
exact asset identity, reject zero or multiple matching records, follow only validated same-origin pagination,
and enforce page/record/byte limits. Every configured component must be present; an older or partial source that
omits contract or liquidity-pool totals is malformed rather than a lower supply value.

Pages or component requests carrying different ledger sequences invalidate the entire attempt. Mid-scan ledger
movement triggers a bounded retry from the beginning, never a mixed-ledger total. A missing asset record is not
proof of zero supply.

## Source independence

Independent endpoints are not automatically independent evidence:

- Horizon instances are replicas of the same canonical ledger and the same Horizon aggregation method. They
  improve availability but count as one derivation family and one expected source class.
- A history-archive or ledger-state replay may count as a second derivation family when it independently
  reconstructs all six components for the same ledger and records its checkpoint and software/method version.
- An issuer or anchor publication is self-reported. It may be compared only when its asset, scope, unit, and
  ledger/time boundary are commensurate; it cannot supply the second independent derivation required for a
  verified result.
- A third-party report counts independently only when provenance demonstrates primary inputs and a derivation
  not copied from one of the configured Horizon endpoints. Rehosted values are replicas.

`verified` requires at least two eligible derivation families that agree exactly at the same ledger. Multiple
Horizon replicas alone remain confidence-capped and `degraded`. Confidence describes evidence quality, not the
probability that an issuer can redeem the asset.

## Consequences

- SUP-02 can implement one bounded Horizon asset-record connector without inventing supply semantics.
- SUP-03 must add a genuinely separate derivation, not another Horizon hostname, before supply can be verified.
- Stored evidence must retain the ledger sequence, component totals, source timestamp, request provenance,
  pagination metadata, and methodology version.
- Public examples and UI labels must use “On-chain asset supply.”
- Native XLM and contract-token supply remain unavailable until their own profiles are approved.
- The generic public v1 serializer maps the legacy domain discriminator to `onchain_asset_supply`. No deployed
  supply endpoint or persisted supply snapshot exists, so this introduces no migration or released-response break.

## Alternatives rejected

- **Sum authorized trustlines only:** omits outstanding frozen, claimable, pooled, and contract-held units.
- **Subtract issuer-related accounts:** Stellar does not provide authoritative beneficial-ownership attribution.
- **Treat Horizon replicas as independent:** duplicates one canonical fact and one aggregation method.
- **Reuse the issued-asset formula for XLM:** ignores the native fee pool and policy-defined non-circulating
  account buckets.

## References

- [Stellar Asset Contract balance storage and burn semantics](https://developers.stellar.org/docs/tokens/stellar-asset-contract)
- [Horizon asset object and aggregate balance fields](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/assets/object)
- [Horizon response ledger consistency](https://developers.stellar.org/docs/data/apis/horizon/api-reference/structure)
- [Horizon pagination](https://developers.stellar.org/docs/data/apis/horizon/api-reference/structure/pagination)
- [Claimable-balance ownership semantics](https://developers.stellar.org/docs/build/guides/transactions/claimable-balances)
- [Native XLM supply definitions](https://developers.stellar.org/docs/learn/fundamentals/lumens)
