
export const problems = [
  {
    term: 'Decision paralysis',
    def: "Traders can't act on asset supply or liquidity figures they can't independently confirm.",
  },
  {
    term: 'Development friction',
    def: 'Builders lose weeks writing one-off aggregation scripts instead of shipping product.',
  },
  {
    term: 'Undisclosed risk',
    def: 'Anchors and issuers can drift from their own published metrics with no one watching.',
  },
]

export const pipeline = [
  {
    tag: 'INGEST',
    term: 'Aggregation',
    def: 'Real-time ingestion from every major Stellar endpoint: Horizon, Archive, path-finding, DEX, and ecosystem APIs.',
  },
  {
    tag: 'RECONCILE',
    term: 'Cross-verification',
    def: 'Multi-source reconciliation flags discrepancies and computes a weighted, probabilistic ground truth.',
  },
  {
    tag: 'SERVE',
    term: 'Actionable output',
    def: 'Verified data via REST, WebSocket streams, and a dashboard — with a confidence score attached to every value.',
  },
]

export const audiences = [
  {
    tag: 'BUILD',
    term: 'dApp developers',
    def: 'One reliable data source to integrate into smart contracts or off-chain services.',
  },
  {
    tag: 'ISSUE',
    term: 'Asset issuers and anchors',
    def: 'Monitor your own published metrics against network reality, continuously.',
  },
  {
    tag: 'TRADE',
    term: 'Institutional traders',
    def: 'Verified order-book depth and asset supply before you execute size.',
  },
  {
    tag: 'RESEARCH',
    term: 'Ecosystem analysts',
    def: "A dependable base layer for dashboards and reports on Stellar's health.",
  },
]
