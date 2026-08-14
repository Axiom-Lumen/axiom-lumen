# Archive state-replay supply adapter

`fetchArchiveSupplyObservation` ingests a versioned artifact produced by an independent Stellar history-archive
state replay. It does not query Horizon and does not treat another Horizon hostname as independent evidence.

The replay producer is expected to use Stellar's ingestion tooling to reconstruct ledger entries from checkpoint
bucket files and to verify the destination ledger against a trusted checkpoint hash. Stellar documents
`CheckpointChangeReader` as the reader for reconstructing state from history-archive buckets at a checkpoint,
and Stellar Core catchup supports trusted checkpoint hashes and extra archive verification:

- [Ledger readers](https://developers.stellar.org/docs/data/indexers/build-your-own/ingest-sdk/developer_guide/ledgerreaders)
- [Stellar Core commands](https://developers.stellar.org/docs/validators/admin-guide/commands)
- [Publishing and verifying history archives](https://developers.stellar.org/docs/validators/admin-guide/publishing-history-archives)

## Artifact contract

The adapter accepts `onchain-supply-archive-replay-v1` JSON containing:

- exact network and classic credit-asset identities;
- closed ledger sequence, close time, and ledger hash;
- all six `onchain-asset-supply-v0.1` component strings and their declared total;
- replay-tool and Stellar Core versions;
- replay start/end ledgers;
- trusted ledger hash, bucket-list hash, and history-archive-state SHA-256 digest;
- artifact generation time.

The caller must provide a trusted checkpoint obtained independently of the artifact. It contains the sequence,
ledger hash, canonical artifact SHA-256, and provenance for the signed manifest or Stellar Core
extra-verification result. The adapter rejects the payload unless its complete canonical content matches that
trusted digest and its ledger and replay endpoint match the checkpoint. It then recomputes the component total
with `StellarAmount` and returns the shared raw `circulating_supply` domain observation with derivation family
`history_archive_state_replay`.

The trusted artifact digest prevents an endpoint from changing component amounts, including offsetting changes
that preserve the total, while retaining a valid ledger hash. Manifest identity, source, verification method,
verification-proof digest, and verification time are persisted with the checkpoint so acceptance remains
reconstructable.

## Independence and attribution

The shared observation contract binds derivation family to source identity:

- `horizon_asset_aggregate` requires the `horizon` adapter and `canonical_ledger` source class;
- `history_archive_state_replay` requires the `archive` adapter and `archive` source class.

This makes Horizon and a verified archive replay comparable at the same ledger without allowing Horizon replicas
to masquerade as independent derivations. `assessSupplyEvidence` exposes the resulting status ceiling: exact
asset, network, cycle, ledger, close-time, total, and component-vector agreement across Horizon and archive
derivations is verification-eligible, while replicas, incompatible scopes, or disagreement are capped at
degraded. The adapters perform no weighted reconciliation; the SUP-04 worker pipeline owns the final status,
confidence, discrepancies, and persistence.

Anchor-published values are intentionally unsupported here. They remain contextual, cannot satisfy the second
independent derivation requirement, and require ANC-01's verified `stellar.toml` discovery before ingestion.

## Failure behavior

Expected failures are returned as structured results, including invalid configuration or assets, transport and
timeout failures, redirects, HTTP/rate-limit responses, oversized or malformed artifacts, network mismatches,
checkpoint mismatches, trusted-artifact integrity mismatches, and declared-total mismatches. Redirects and unsafe
endpoint hosts fail closed.

The recorded test fixture is redacted and independently calculable. A separate capture-provenance sidecar records
its capture type, timestamp, exact artifact digest, and redacted fields. It contains no archive credentials,
operator hostname, or private infrastructure metadata.
