# Trustline state methodology v0.1

This profile measures classic credit-asset trustlines grouped by their mutually exclusive ledger authorization
state. Its executable configuration is `config/methodology/trustlines_v0_1.ts`.

- Public metric: `trustline_state` at `GET /api/v1/trustlines/{asset}`.
- Supported subjects: classic `CODE:ISSUER` credit assets on the Stellar Public Network. Native XLM has no
  trustline and is rejected.
- States: `authorized`, `authorized_to_maintain_liabilities`, and `unauthorized`.
- Total: the exact integer sum of those three states.
- Boundary: Horizon's exact asset aggregate plus its `Latest-Ledger` header and corresponding ledger close time.
- Funded holders: not measured. Positive-balance accounts, wallet users, and beneficial owners are different
  metrics and must not be inferred from trustline counts.
- Freshness: 300-second half-life and 900-second maximum evidence age.
- Agreement: exact equality of every state, not merely the total.
- Independence: Horizon replicas use `horizon_asset_aggregate` and cannot satisfy the two-independent-derivation
  requirement. Horizon-only output is degraded, never verified.

Confidence uses `trustline-state-confidence-v0.1`: agreement 0.55, freshness 0.20, availability 0.20, and spread
0.05. Caps are 0.60 for one source, 0.70 for same-derivation replicas, and 0.85 when source errors exist.
