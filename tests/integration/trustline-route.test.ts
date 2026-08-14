import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiErrorResponseSchema, apiReconciliationSnapshotSchema, reconciliationSnapshotSchema } from '../../lib/contracts'
import type { TrustlineReadModel } from '../../lib/db/trustline-read-model'
import { expectOpenApiResponse } from '../helpers/openapi-response'

vi.mock('../../lib/db/api-access-repository', () => ({ authorizePublicApiKey: vi.fn(async () => ({ status: 'allowed', grant: { principalId: 'test', planId: 'developer', limit: 60, remaining: 59, resetAt: '2026-08-10T10:01:00.000Z' } })) }))
const readModel = vi.hoisted(() => ({ load: vi.fn() })); vi.mock('../../lib/db/trustline-read-model', () => ({ loadLatestTrustlineReadModel: readModel.load }))
import { GET, OPTIONS, POST } from '../../app/api/v1/trustlines/[asset]/route'
const ISSUER = `G${'A'.repeat(55)}`; const ASSET = `USDC:${ISSUER}`; const NOW = '2026-08-10T12:00:00.000Z'
function snapshot(): TrustlineReadModel['snapshot'] { return reconciliationSnapshotSchema.parse({ snapshotId: 'snapshot_trustlines', cycleId: 'cycle_trustlines', metric: 'trustline_count', subject: { kind: 'asset', asset: { kind: 'credit', code: 'USDC', issuer: ISSUER } }, status: 'degraded', value: { kind: 'trustline_state', total: '825', states: { authorized: '700', authorized_to_maintain_liabilities: '100', unauthorized: '25' }, ledgerSequence: 500, ledgerClosedAt: NOW }, confidence: { score: 0.6, formulaVersion: 'trustline-state-confidence-v0.1', components: { agreement: 1, freshness: 1, availability: 1, spread: 1 }, capsApplied: ['single_source'] }, sourcesConfigured: 1, sourcesResponded: 1, sourcesUsable: 1, sourcesAgreeing: 1, sourcesExcluded: 0, contributions: [], discrepancies: [], sourceErrors: [], asOf: NOW, methodologyVersion: 'trustline-state-v0.1' }) }
function request(asset = ASSET, query = '') { return GET(new Request(`https://axiom.example/api/v1/trustlines/${asset}${query}`, { headers: { 'X-Request-ID': 'req_trustlines' } }), { params: Promise.resolve({ asset }) }) }
describe('GET /api/v1/trustlines/{asset}', () => {
  afterEach(() => { readModel.load.mockReset(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
  it('fails closed before storage reads when trustlines are disabled', async () => {
    vi.stubEnv('AXIOM_FEATURE_TRUSTLINES_ENABLED', 'false')
    const response = await request()
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'feature_not_available' } })
    expect(readModel.load).not.toHaveBeenCalled()
  })
  it('serves finalized authorization-state counts', async () => {
    readModel.load.mockResolvedValue({ snapshot: snapshot(), stale: false, freshForSeconds: 800 })
    const response = await request(); await expectOpenApiResponse(response.clone(), '/api/v1/trustlines/{asset}', 'get'); const body = await response.json()
    expect(response.status).toBe(200); expect(body).toMatchObject({ metric: 'trustline_state', value: { kind: 'trustline_state', total: '825', states: { authorized: '700', unauthorized: '25' } } }); expect(apiReconciliationSnapshotSchema.parse(body)).toEqual(body)
  })
  it('fails closed for stale evidence and rejects native XLM', async () => {
    readModel.load.mockResolvedValue({ snapshot: snapshot(), stale: true, freshForSeconds: 0 })
    expect((await request()).status).toBe(503); expect((await request('native')).status).toBe(400)
  })
  it('returns a typed not-found response without fabricating a value', async () => {
    readModel.load.mockResolvedValue(null)
    const response = await request(); const body = await response.json()
    expect(response.status).toBe(404)
    expect(body.error).toMatchObject({ code: 'trustline_snapshot_not_found' })
    expect(apiErrorResponseSchema.parse(body)).toEqual(body)
  })
  it('sanitizes read-store failures and rejects unexpected query parameters', async () => {
    readModel.load.mockRejectedValue(new Error('postgres://user:secret@db.internal/axiom'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failed = await request(); const failedBody = await failed.json()
    expect(failed.status).toBe(503)
    expect(failedBody.error).toMatchObject({ code: 'trustline_read_unavailable' })
    expect(JSON.stringify(failedBody)).not.toContain('secret')
    readModel.load.mockReset()
    const invalidQuery = await request(ASSET, '?cursor=unexpected')
    expect(invalidQuery.status).toBe(400)
    expect((await invalidQuery.json()).error.code).toBe('invalid_query_parameter')
    expect(readModel.load).not.toHaveBeenCalled()
  })
  it('supports CORS preflight and rejects unsupported methods', async () => {
    const url = `https://axiom.example/api/v1/trustlines/${ASSET}`
    const preflight = OPTIONS(new Request(url, { method: 'OPTIONS', headers: { 'X-Request-ID': 'req_trustline_options' } }))
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS')
    const unsupported = POST(new Request(url, { method: 'POST', headers: { 'X-Request-ID': 'req_trustline_post' } }))
    expect(unsupported.status).toBe(405)
    expect((await unsupported.json()).error.code).toBe('method_not_allowed')
  })
})
