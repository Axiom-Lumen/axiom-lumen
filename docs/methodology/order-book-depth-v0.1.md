# Order-book depth methodology v0.1

Status: implemented ingestion profile; not yet a public reconciled metric.

This profile defines deterministic classic Stellar DEX (SDEX) offer depth for one trading pair. It serves
market makers and institutional traders who need size context with a precise ledger and time boundary. DEX-02
will add persistence, cross-source reconciliation, confidence scoring, and a public endpoint. Until then, the
connector output is raw evidence and must not be described as verified depth.

## Pair and price convention

A pair is stored in one canonical orientation. Native XLM sorts before credit assets; credit assets sort by
uppercase code and then issuer account. Reversing a requested pair therefore resolves to the same key and the
connector records that the request was reversed.

- `base` is the asset whose executable quantity is measured.
- `counter` is the denomination of price.
- Every price is exact `counter / base`, represented by a positive rational numerator and denominator.
- Horizon's decimal `price` is validation-only. Calculations use `price_r` and never JavaScript floating point.

## Sides, units, and rounding

- An ask sells base for counter. Its base amount is the offer's selling amount.
- A bid sells counter for base. Its base-equivalent amount is `counter amount × (base / counter)`.
- Multiplication rounds down to seven decimal places. This avoids claiming an executable stroop that the offer
  cannot provide.
- Aggregated bid and ask depth are both expressed in base-asset-equivalent units, so their units are comparable.

The reference price is the exact midpoint of the best bid and best ask. The executable profile publishes
cumulative depth within 50, 100, and 500 basis points of that midpoint. Boundaries are inclusive. Offers beyond
the requested band remain in raw evidence but do not contribute to that bucket.

## Ledger and time boundary

The connector scans exact selling/buying filters for both sides of `/offers`. Every page must carry the same
positive `Latest-Ledger` header. If the ledger changes, the complete two-sided scan restarts within a bounded
budget; partial mixed-ledger depth is never emitted. The corresponding ledger close time is the source
timestamp.

The freshness half-life is 5 seconds and the hard observation age is 20 seconds. A book older than 20 seconds
at retrieval fails as stale. DEX-02 will apply freshness decay during reconciliation.

## Book states and exclusions

- A two-sided book must have `best bid < best ask`. A crossed book is rejected as inconsistent evidence.
- An empty book and a one-sided book are retained as explicit states. Because neither has a two-sided midpoint,
  neither produces price-band observations.
- Thin books are valid when both sides exist; empty buckets remain exact zero amounts.
- Classic offers only are included. Liquidity-pool reserves and path-payment liquidity are excluded from v0.1
  because their executable depth curves require a separate slippage model.
- Multiple Horizon servers expose replicas of the same canonical SDEX state. They improve availability but do
  not count as independent corroboration.

No non-Horizon corroborating source is approved in v0.1. Adding one requires documented pair, price, ledger,
fee, and liquidity-pool semantics before it can participate in reconciliation.

## Failure behavior

Expected failures are structured: invalid pair/configuration, transport or HTTP failure, rejected redirect,
oversized or malformed payload, network mismatch, exhausted scan budget, ledger drift, duplicate pagination,
crossed book, and stale book. Credentials, response bodies, and internal exceptions are not included in public
messages.
