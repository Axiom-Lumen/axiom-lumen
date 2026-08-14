# Horizon SDEX order-book depth connector

`fetchHorizonOrderBookDepth` implements the ingestion boundary for
[`order-book-depth-v0.1`](../methodology/order-book-depth-v0.1.md).

## Collection sequence

1. Validate the source as a `dex` / `sdex` identity, the expected network, canonical pair, endpoint policy,
   and scan budgets.
2. Read the Horizon root and require the configured network passphrase.
3. Scan asks from offers selling base and buying counter.
4. Scan bids from offers selling counter and buying base.
5. Require one `Latest-Ledger` across every page on both sides.
6. Read that ledger's close time and reject stale, future-dated, or crossed evidence.
7. Aggregate exact base-equivalent amounts into the versioned price bands.

The adapter requests pages in ascending cursor order, accepts only same-origin next links that preserve every
pair and bound parameter, rejects repeated URLs or paging tokens, and caps response bytes, pages, records,
timeouts, and complete-scan ledger restarts. A scan that reaches a bound returns `partial_scan`; it does not
emit a partial amount.

Each successful result retains the canonical pair, whether the request was reversed, exact best prices and
midpoint, raw levels, cumulative buckets, ledger sequence and close time, request timestamps, payload hashes,
scan counts, methodology and connector versions, and one evidence digest. Normalized raw observations are
created only for a complete two-sided book.

## Trust boundary

The connector uses Horizon to read canonical classic SDEX offers. Different Horizon hosts remain replicas of
the same derivation family and are not independent corroboration. Liquidity pools are explicitly excluded.
Persistence, reconciliation, confidence, and `GET /api/v1/depth/{pair}` are provided by
[`order-book-depth-v0.2`](../methodology/order-book-depth-v0.2.md). The connector remains the v0.1 raw-evidence
boundary; its output is not independently verified by itself.
