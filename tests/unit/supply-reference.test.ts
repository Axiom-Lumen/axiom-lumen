import { describe, expect, it } from 'vitest'
import { assertSupplyReferenceSubject } from '../../lib/db/repositories'

const ISSUER = `G${'A'.repeat(55)}`
const observation = {
  observationId: 'observation_supply', cycleId: 'cycle_supply', metric: 'circulating_supply',
  asset: { kind: 'credit', code: 'USDC', issuer: ISSUER }, amount: '1',
  components: {
    authorized_trustlines: '1', maintain_liabilities_trustlines: '0', unauthorized_trustlines: '0',
    claimable_balances: '0', liquidity_pools: '0', contract_balances: '0',
  },
  ledgerSequence: 500, methodologyVersion: 'onchain-asset-supply-v0.1',
  provenance: {
    source: { id: 'horizon_1', sourceClass: 'canonical_ledger', adapter: 'horizon', url: 'https://horizon.example', network: { id: 'public', passphrase: 'Public Global Stellar Network ; September 2015' } },
    sourceTimestamp: '2026-08-11T12:00:00.000Z', retrievedAt: '2026-08-11T12:00:05.000Z',
  },
  derivation: {
    family: 'horizon_asset_aggregate', connectorVersion: 'horizon-supply-v0.1', evidenceSha256: 'a'.repeat(64),
    software: { name: 'stellar-horizon', version: null },
    checkpoint: { kind: 'horizon_asset_page', ledgerSequence: 500, terminalCursor: 'asset-500', pagesScanned: 1, recordsScanned: 1 },
  },
}

describe('supply reference repository boundary', () => {
  it('accepts evidence only for the exact network and asset subject', () => {
    expect(assertSupplyReferenceSubject(`public:USDC:${ISSUER}`, observation)).toMatchObject({ ledgerSequence: 500 })
    expect(() => assertSupplyReferenceSubject(`testnet:USDC:${ISSUER}`, observation)).toThrow('requested asset')
    expect(() => assertSupplyReferenceSubject(`public:EURC:${ISSUER}`, observation)).toThrow('requested asset')
  })
})
