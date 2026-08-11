import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiReconciliationSnapshotSchema, reconciliationSnapshotSchema } from '../../lib/contracts'
import type { DepthReadModel } from '../../lib/db/depth-read-model'
import { expectOpenApiResponse } from '../helpers/openapi-response'

const readModel = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../../lib/db/depth-read-model', () => ({ loadLatestDepthReadModel: readModel.load }))
import { GET } from '../../app/api/v1/depth/[pair]/route'

const ISSUER = `G${'A'.repeat(55)}`
const PAIR = `native~USDC:${ISSUER}`
const AS_OF = '2026-08-10T12:00:00.000Z'
function snapshot(): DepthReadModel['snapshot'] {
  return reconciliationSnapshotSchema.parse({
    snapshotId: 'snapshot_depth', cycleId: 'cycle_depth', metric: 'order_book_depth',
    subject: { kind: 'pair', pair: { base: { kind: 'native' }, counter: { kind: 'credit', code: 'USDC', issuer: ISSUER } } },
    status: 'degraded', value: { kind: 'depth', referencePrice: { numerator: '2', denominator: '1', decimal: '2.0000000' }, ledgerSequence: 500, ledgerClosedAt: AS_OF,
      buckets: (['bid', 'ask'] as const).flatMap((side) => ([50, 100, 500] as const).map((priceBandBasisPoints, index) => ({ side, priceBandBasisPoints, value: String((index + 1) * 100) }))) },
    confidence: { score: 0.7, formulaVersion: 'order-book-depth-confidence-v0.2', components: { agreement: 1, freshness: 1, availability: 1, spread: 1 }, capsApplied: ['same_upstream_replicas'] },
    sourcesConfigured: 2, sourcesResponded: 2, sourcesUsable: 2, sourcesAgreeing: 2, sourcesExcluded: 0,
    contributions: [], discrepancies: [], sourceErrors: [], asOf: AS_OF, methodologyVersion: 'order-book-depth-v0.2',
  })
}
function request(pair = PAIR) { return GET(new Request(`https://axiom.example/api/v1/depth/${pair}`, { headers: { 'X-Request-ID': 'req_depth' } }), { params: Promise.resolve({ pair }) }) }

describe('GET /api/v1/depth/{pair}', () => {
  afterEach(() => { readModel.load.mockReset(); vi.restoreAllMocks() })
  it('serves a finalized coherent book without upstream fan-out', async () => {
    readModel.load.mockResolvedValue({ snapshot: snapshot(), stale: false, freshForSeconds: 15 })
    const response = await request(); await expectOpenApiResponse(response.clone(), '/api/v1/depth/{pair}', 'get'); const body = await response.json()
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ metric: 'order_book_depth', subject: { kind: 'pair', base: 'native', counter: `USDC:${ISSUER}` }, value: { kind: 'depth', ledger_sequence: 500, buckets: expect.any(Array) } })
    expect(body.value.buckets).toHaveLength(6)
    expect(apiReconciliationSnapshotSchema.parse(body)).toEqual(body)
  })
  it('canonicalizes a reversed pair request', async () => {
    readModel.load.mockResolvedValue({ snapshot: snapshot(), stale: false, freshForSeconds: 15 })
    expect((await request(`USDC:${ISSUER}~native`)).status).toBe(200)
    expect(readModel.load).toHaveBeenCalledWith(expect.objectContaining({ base: { kind: 'native' } }), expect.any(Date))
  })
  it('fails closed when finalized evidence is stale', async () => {
    readModel.load.mockResolvedValue({ snapshot: snapshot(), stale: true, freshForSeconds: 0 })
    const response = await request(); const body = await response.json()
    expect(response.status).toBe(503); expect(body).toMatchObject({ status: 'unavailable', value: null, source_errors: [expect.objectContaining({ code: 'stale_book' })] })
  })
  it('rejects malformed and same-asset pairs before storage', async () => {
    expect((await request('native~native')).status).toBe(400)
    expect((await request('not-a-pair')).status).toBe(400)
    expect(readModel.load).not.toHaveBeenCalled()
  })
})
