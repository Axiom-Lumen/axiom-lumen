# On-chain asset supply v0.1

This is the normative implementation specification for `onchain-asset-supply-v0.1`. ADR 0005 records why this
scope was selected. The executable invariants live in `config/methodology/supply_v0_1.ts`.

## Scope and identity

- Supported subject: a classic Stellar credit asset, canonically encoded as `CODE:ISSUER`.
- Unsupported subjects: native XLM and tokens issued by a `C...` contract.
- Unit: the asset’s seven-decimal unit, represented internally as integer stroops.
- Public label: **On-chain asset supply**.
- Public metric ID: `onchain_asset_supply` (`circulating_supply` remains an internal pre-API discriminator).
- Canonical future path: `GET /api/v1/supply/{asset}`.
- Explicit non-claims: economic free float, issuer-controlled float, backing, redemption capacity, solvency,
  market capitalization, or investment quality.

An asset is inseparable from its network, code, and issuer. The same code from another issuer or network is a
different subject. A missing exact asset record is unavailable/not found, never an assumed zero.

The issuer account’s `home_domain` is mutable attribution metadata, not part of asset identity or the numeric
formula. If retained, provenance must include the account/ledger at which it was read and the result of the
approved HTTPS `stellar.toml` verification path. An unverified domain cannot turn a source into an issuer or
anchor attestation.

## Formula

Let the following values be non-negative integer stroop counts for asset `A` at closed ledger `L`:

| Symbol | Horizon asset-record field | Treatment |
|---|---|---|
| `T_auth` | `balances.authorized` | Include |
| `T_maintain` | `balances.authorized_to_maintain_liabilities` | Include |
| `T_unauth` | `balances.unauthorized` | Include |
| `C_claimable` | `claimable_balances_amount` | Include once |
| `P_liquidity` | `liquidity_pools_amount` | Include underlying reserve once |
| `S_contract` | `contracts_amount` | Include SAC contract-held units |

```text
S(A, L) = T_auth + T_maintain + T_unauth + C_claimable + P_liquidity + S_contract
```

The same-ledger comparison tolerance is zero stroops. A non-zero difference between complete independent
derivations is a measured discrepancy. Values at different ledgers are not comparable observations.

### Treatments that do not add terms

- Buying and selling liabilities are already encumbrances on trustline balances; adding them would double count.
- Sponsorship pays ledger-entry reserves but does not transfer the balance.
- A claimable balance is counted once, not once per claimant.
- Pool-share balances represent claims on a pool and are not additional units of either reserve asset.
- Authorization and clawback flags describe controls. Existing balances remain outstanding until transferred
  to the issuer, burned, or clawed back.
- No account is inferred to be issuer-controlled merely from metadata, domain, signer, or transaction history.

## Observation acceptance

A connector may emit an observation only when all of these conditions hold:

1. The requested network and exact `CODE:ISSUER` identity match the returned record.
2. All six formula components are present, canonical decimal strings, and non-negative.
3. Decimal parsing and addition use `StellarAmount`/stroops without floating-point conversion.
4. Every page or component response reports the same valid `Latest-Ledger` sequence.
5. Pagination terminates normally within configured page, record, response-byte, retry, and timeout budgets.
6. Record IDs/cursors do not repeat, and an exact asset query yields exactly one record.
7. The ledger close time is persisted as the source timestamp and the completed retrieval time is distinct.

Missing fields, duplicate records, cursor loops, mixed ledgers, negative/malformed amounts, or exhausted bounds
are structured source failures. Partial totals are never published or carried forward as current.

Required retained provenance:

- network identity and passphrase;
- exact asset identity;
- source identity and derivation family;
- closed ledger sequence and close time;
- all six component strings and exact total;
- request/retrieval timestamps;
- page count, terminal cursor, record count, and payload digests;
- connector and methodology versions.

## Independence and status

| Evidence | Availability value | Independent derivation value |
|---|---:|---:|
| Additional Horizon hostname | Yes | No |
| Independently operated Horizon with the same asset aggregate | Yes | No |
| Complete archive/state replay at the same ledger | Yes | Yes |
| Issuer/anchor self-report | Context only | No |
| Third-party derivation with documented primary inputs | Yes | Case-by-case |
| Rehosted Horizon or explorer value | Yes | No |

At least two eligible derivation families must agree exactly for `verified`. Otherwise a usable value is
`degraded` and confidence-capped. A report with an incompatible scope or timestamp is excluded, not coerced.

Freshness decays with a 30-second half-life. An observation more than 120 seconds behind cycle finalization is
retained as immutable raw evidence but cannot contribute a current value; all-stale evidence produces an
`unavailable` snapshot. Confidence uses the versioned `onchain-asset-supply-confidence-v0.1` formula with
agreement `0.55`, freshness `0.20`, availability `0.20`, and spread `0.05`. Expected source-class diversity is
multiplicative. Verified status requires a score of at least `0.90`; single-source, same-derivation, and
source-error caps are `0.60`, `0.70`, and `0.85` respectively.

## Worked examples

### Complete issued-asset total

At ledger `L`, an asset has:

```text
authorized trustlines                 700.0000000
maintain-liabilities trustlines       100.0000000
unauthorized trustlines                25.0000000
claimable balances                     50.0000000
liquidity pools                        75.0000000
contract balances                      50.0000000
                                      ------------
on-chain asset supply                1000.0000000
```

### Container transfer does not change supply

Moving `40.0000000` from an authorized trustline into a contract changes those components to `660.0000000`
and `90.0000000`. The total remains `1000.0000000`; counting both the pre-transfer balance and the contract
credit would be a connector defect.

### Burn or clawback changes supply

If `10.0000000` is clawed back from the unauthorized balance, that balance becomes `15.0000000` and total
supply becomes `990.0000000`. A direct transfer of `20.0000000` to the issuer similarly burns those units.

### Replicas do not create verification

Three Horizon endpoints each report `1000.0000000` at ledger `L`. They demonstrate availability and agreement
among replicas, but still represent one Horizon derivation of one canonical ledger. The snapshot is degraded
until an eligible archive/state replay independently derives the same six-component total.

### Native XLM is not this metric

Suppose a native-supply source reports `1000.0000000` total XLM, a `10.0000000` fee pool, a
`200.0000000` policy-managed mandate bucket, and a `50.0000000` upgrade reserve. A native profile might derive
`740.0000000`, but only after validating the time-versioned account registry and the semantics of every bucket.
The six credit-asset components contain none of that policy evidence. `native` is therefore rejected by v0.1
rather than returning a plausible but incorrectly scoped number.

## Review checklist

- [x] Issued versus economically circulating scope is explicit.
- [x] Issuer, authorization, clawback, sponsorship, claims, pools, and contracts are defined.
- [x] Ledger and pagination completeness rules are deterministic.
- [x] Replica and derivation independence are distinct.
- [x] Native XLM and contract tokens fail closed.
- [x] Worked examples are independently calculable.
- [x] Public path and label match the measured scope.
- [x] Issuer identity and mutable home-domain provenance are separated.
