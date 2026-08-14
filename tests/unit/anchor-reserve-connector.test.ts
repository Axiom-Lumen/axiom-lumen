import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fetchAnchorReserveObservation } from '../../lib/stellar/anchor-reserve'

const ISSUER = `G${'A'.repeat(55)}`
const ASSET_ID = `USDC:${ISSUER}`
const source = {
  id: 'anchor_source', sourceClass: 'anchor_self_reported' as const, adapter: 'anchor' as const,
  url: 'https://evidence.example/reserve.json',
  network: { id: 'public' as const, passphrase: 'Public Global Stellar Network ; September 2015' },
}
const payload = {
  schema: 'axiom-lumen-anchor-reserve-attestation-v1',
  asset: ASSET_ID,
  unit: { kind: 'asset_units', asset: ASSET_ID },
  reserve_amount: '1000.0000000',
  period_start: '2026-08-11T11:00:00Z',
  period_end: '2026-08-11T11:59:00Z',
  published_at: '2026-08-11T12:00:00Z',
}

describe('anchor reserve connector', () => {
  it('normalizes a strict exact-asset-unit attestation', async () => {
    const rawText = JSON.stringify(payload, null, 2)
    const result = await fetchAnchorReserveObservation({
      observationId: 'observation_1', cycleId: 'cycle_1', anchorId: 'anchor_1', source,
      asset: { kind: 'credit', code: 'USDC', issuer: ISSUER }, resolve: async () => ['93.184.216.34'],
      connectImpl: vi.fn(async () => new Response(rawText, { headers: { 'content-type': 'application/json' } })), clock: () => new Date('2026-08-11T12:00:05.000Z'),
    })
    expect(result).toMatchObject({ observation: { metric: 'anchor_reserves', amount: expect.any(Object), attestationPeriodEnd: '2026-08-11T11:59:00.000Z' } })
    expect(result).toMatchObject({ observation: { attestation: { evidenceSha256: createHash('sha256').update(rawText).digest('hex') } }, evidence: { rawText } })
  })

  it('rejects a differently denominated reserve figure', async () => {
    const result = await fetchAnchorReserveObservation({
      observationId: 'observation_1', cycleId: 'cycle_1', anchorId: 'anchor_1', source,
      asset: { kind: 'credit', code: 'USDC', issuer: ISSUER }, resolve: async () => ['93.184.216.34'],
      connectImpl: vi.fn(async () => Response.json({ ...payload, unit: { kind: 'asset_units', asset: `EUR:${ISSUER}` } })),
    })
    expect(result).toMatchObject({ error: { code: 'unit_mismatch' } })
  })

  it('rejects endpoints resolving to private infrastructure before fetching', async () => {
    const connectImpl = vi.fn()
    const result = await fetchAnchorReserveObservation({
      observationId: 'observation_1', cycleId: 'cycle_1', anchorId: 'anchor_1', source,
      asset: { kind: 'credit', code: 'USDC', issuer: ISSUER }, resolve: async () => ['10.0.0.2'], connectImpl,
    })
    expect(result).toMatchObject({ error: { code: 'unsafe_endpoint' } })
    expect(connectImpl).not.toHaveBeenCalled()
  })

  it('honors Retry-After on retryable HTTP responses', async () => {
    const result = await fetchAnchorReserveObservation({
      observationId: 'observation_1', cycleId: 'cycle_1', anchorId: 'anchor_1', source,
      asset: { kind: 'credit', code: 'USDC', issuer: ISSUER }, resolve: async () => ['93.184.216.34'],
      connectImpl: vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '7' } })),
      clock: () => new Date('2026-08-11T12:00:05.000Z'),
    })
    expect(result).toMatchObject({ error: { code: 'non_200_response', status: 429, retryAfterMs: 7_000 } })
  })
})
