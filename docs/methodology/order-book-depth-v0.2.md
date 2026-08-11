# Persisted order-book depth methodology v0.2

This profile reconciles and publishes the classic-offer evidence defined by
[`order-book-depth-v0.1`](./order-book-depth-v0.1.md). Its executable configuration is
`config/methodology/depth_v0_2.ts`.

- Route: `GET /api/v1/depth/{pair}` on the Stellar Public Network.
- Pair identifier: canonical `BASE~COUNTER`; `native` sorts before credit assets and a reversed request resolves
  to the same persisted subject.
- Value: one coherent source book containing the exact rational midpoint, ledger sequence and close time, plus
  cumulative bid and ask base-equivalent amounts at 50, 100, and 500 basis points.
- Reference selection: weighted median of total 500-basis-point bid-plus-ask depth. The selected value is an
  actual source book; buckets from different sources are never combined.
- Agreement: exact rational midpoint and no bucket differing by more than 50 basis points relative to the
  selected book. All amount comparisons use stroops and integer arithmetic.
- Freshness: five-second half-life and 20-second maximum evidence age. The API converts an expired finalized
  snapshot to `unavailable` and never performs synchronous Horizon requests.
- Empty and one-sided books: retained as successful raw evidence with explicit `empty_book` or `one_sided_book`
  source errors, but are not usable reconciliation observations.
- Independence: Horizon replicas share `horizon_sdex_offers`; they cannot satisfy the two-independent-derivation
  verification requirement and receive the `same_upstream_replicas` confidence cap.
- Liquidity pools remain excluded. This endpoint describes classic SDEX offer depth only.

Confidence uses `order-book-depth-confidence-v0.2`: agreement 0.55, freshness 0.20, availability 0.20, and
spread 0.05. Caps are 0.60 for one usable source, 0.70 for same-derivation replicas, and 0.85 when source errors
are present. Until another approved derivation is implemented, production Horizon-only depth is expected to be
`degraded`, not `verified`.
