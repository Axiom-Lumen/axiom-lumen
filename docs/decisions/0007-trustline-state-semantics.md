# ADR 0007: Publish trustline authorization state, not holder estimates

## Decision

Publish the three classic trustline authorization-state counts returned by the ledger-derived Horizon asset
aggregate and their exact sum. Name the public metric `trustline_state`.

Do not label the total as holders, funded holders, users, or wallets. Zero-balance trustlines are included, one
account can control many trustlines, and beneficial ownership is not present on ledger. A funded-holder metric
requires a separately versioned positive-balance scan and its own ledger-consistency and identity rules.

Horizon host replicas remain one derivation family. They improve availability but cannot independently verify
the state. The endpoint serves finalized persistence only and fails closed after its freshness bound.
