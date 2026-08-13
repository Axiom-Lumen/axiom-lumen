import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiAnchorReservesResponseSchema, apiErrorResponseSchema } from '../../lib/contracts'
import { InvalidAnchorReserveCursorError } from '../../lib/db/anchor-public-read-model'
import { parseStellarAmount } from '../../lib/stellar/amount'
import { expectOpenApiResponse } from '../helpers/openapi-response'

const readModel = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../../lib/db/anchor-public-read-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/db/anchor-public-read-model')>()),
  loadPublicAnchorReserves: readModel.load,
}))

import { GET, OPTIONS, POST } from '../../app/api/v1/anchors/[anchor]/reserves/route'

const PATH = '/api/v1/anchors/{anchor}/reserves'
const model = {
  anchor: { id: 'anchor-a', name: 'Anchor A', networkId: 'public', stellarAccount: null, status: 'verified' },
  asOf: '2026-08-12T10:03:00.000Z', nextCursor: null,
  disclosures: [{
    flagId: 'flag-a', severity: 'warning', lifecycleState: 'open', publicationState: 'approved_public',
    methodologyVersion: 'anchor-reserve-comparison-v0.1', approvedAt: '2026-08-12T10:03:00.000Z', firstObservedAt: '2026-08-12T10:00:00.000Z', lastObservedAt: '2026-08-12T10:01:00.000Z',
    measurement: {
      eventId: 'event-a', measuredAt: '2026-08-12T10:01:00.000Z', asset: { kind: 'credit', code: 'USD', issuer: `G${'A'.repeat(55)}` },
      reserveAmount: parseStellarAmount('970'), onchainSupply: parseStellarAmount('1000'), absoluteDelta: parseStellarAmount('30'), deltaBasisPoints: 300,
      attestationPeriodStart: '2026-08-12T09:00:00.000Z', attestationPeriodEnd: '2026-08-12T10:00:00.000Z', publishedAt: '2026-08-12T10:00:30.000Z',
      attestation: { schema: 'axiom-lumen-anchor-reserve-attestation-v1', documentUrl: 'https://anchor.example/reserves', evidenceSha256: 'a'.repeat(64) },
      source: { id: 'source-a', url: 'https://anchor.example/reserves', sourceClass: 'anchor_self_reported' },
      supplyReference: { snapshotId: 'supply-a', amount: '1000', asOf: '2026-08-12T10:00:00.000Z', ledgerSequence: 100, ledgerClosedAt: '2026-08-12T10:00:00.000Z', status: 'verified', confidence: 0.95, methodologyVersion: 'onchain-asset-supply-v0.1' },
      confidence: { score: 0.49, formulaVersion: 'anchor-reserve-confidence-v0.1', components: { attestation: 1, reference: 0.95, temporal_alignment: 1 }, capsApplied: ['anchor_self_reported'] },
    },
    response: { body: 'Measured context', version: 1, submittedAt: '2026-08-12T10:02:00.000Z', reviewedAt: '2026-08-12T10:03:00.000Z', evidence: [] },
    disputes: [], corrections: [],
  }],
}

function request(anchor = 'anchor-a', init?: RequestInit, query = '') {
  return GET(new Request(`https://axiom.example/api/v1/anchors/${anchor}/reserves${query}`, init), { params: Promise.resolve({ anchor }) })
}

describe('GET /api/v1/anchors/{anchor}/reserves', () => {
  afterEach(() => { vi.restoreAllMocks(); readModel.load.mockReset() })

  it('serves only the publication-gated public read model', async () => {
    readModel.load.mockResolvedValue(model)
    const response = await request('anchor-a', { headers: { 'X-Request-ID': 'anchor_request' } })
    await expectOpenApiResponse(response.clone(), PATH, 'get')
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ anchor: { id: 'anchor-a', network: 'public', status: 'verified' }, disclosures: [{ flag_id: 'flag-a', publication_state: 'approved_public', measurement: { asset: `USD:G${'A'.repeat(55)}`, reserve_amount: '970', onchain_supply: '1000', absolute_delta: '30' } }], page: { next_cursor: null }, request_id: 'anchor_request' })
    expect(apiAnchorReservesResponseSchema.parse(body)).toEqual(body)
    expect(response.headers.get('etag')).toMatch(/^W\//)
  })

  it('returns an empty collection without disclosing internal case existence', async () => {
    readModel.load.mockResolvedValue({ ...model, disclosures: [] })
    const response = await request()
    expect(response.status).toBe(200)
    expect((await response.json()).disclosures).toEqual([])
  })

  it('passes bounded pagination through and returns the opaque next cursor', async () => {
    readModel.load.mockResolvedValue({ ...model, nextCursor: 'next_page' })
    const response = await request('anchor-a', undefined, '?limit=10&cursor=current_page')
    expect(response.status).toBe(200)
    expect(readModel.load).toHaveBeenCalledWith('anchor-a', { limit: 10, cursor: 'current_page' })
    expect((await response.json()).page).toEqual({ next_cursor: 'next_page' })
  })

  it('uses stable persisted timestamps for conditional requests', async () => {
    readModel.load.mockResolvedValue(model)
    const first = await request('anchor-a')
    const etag = first.headers.get('etag')!
    const second = await request('anchor-a', { headers: { 'If-None-Match': etag } })
    await expectOpenApiResponse(second.clone(), PATH, 'get')
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
  })

  it('rejects invalid identifiers before storage and distinguishes missing verified anchors', async () => {
    const invalid = await request('contains%20spaces')
    await expectOpenApiResponse(invalid.clone(), PATH, 'get')
    expect(invalid.status).toBe(400)
    expect(readModel.load).not.toHaveBeenCalled()

    readModel.load.mockResolvedValue(null)
    const missing = await request()
    await expectOpenApiResponse(missing.clone(), PATH, 'get')
    expect(missing.status).toBe(404)
    expect(apiErrorResponseSchema.parse(await missing.json()).error.code).toBe('anchor_not_found')
  })

  it('standardizes query, storage-failure, CORS, and method behavior', async () => {
    const query = await request('anchor-a', undefined, '?internal=true')
    expect(query.status).toBe(400)
    expect((await query.json()).error.code).toBe('invalid_query_parameter')

    const excessiveLimit = await request('anchor-a', undefined, '?limit=101')
    expect(excessiveLimit.status).toBe(400)
    expect((await excessiveLimit.json()).error.code).toBe('invalid_pagination')

    readModel.load.mockRejectedValueOnce(new InvalidAnchorReserveCursorError())
    const cursor = await request('anchor-a', undefined, '?cursor=bad')
    expect(cursor.status).toBe(400)
    expect((await cursor.json()).error.code).toBe('invalid_pagination')

    readModel.load.mockRejectedValue(new Error('secret database detail'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unavailable = await request()
    await expectOpenApiResponse(unavailable.clone(), PATH, 'get')
    expect(unavailable.status).toBe(503)
    expect(JSON.stringify(await unavailable.json())).not.toContain('secret')

    const options = OPTIONS(new Request('https://axiom.example/api/v1/anchors/anchor-a/reserves', { method: 'OPTIONS' }))
    await expectOpenApiResponse(options.clone(), PATH, 'options')
    expect(options.status).toBe(204)
    expect(POST(new Request('https://axiom.example/api/v1/anchors/anchor-a/reserves', { method: 'POST' })).status).toBe(405)
  })
})
