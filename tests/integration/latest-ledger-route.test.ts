import { afterEach, describe, expect, it, vi } from 'vitest'
import { latestLedgerResponseSchema, type LatestLedgerReconciliationResult } from '../../lib/reconcile/latest-ledger'

const readModel = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../../lib/db/latest-ledger-read-model', () => ({ loadLatestLedgerReadModel: readModel.load }))

import { GET } from '../../app/api/v1/stellar/latest-ledger/route'

const finalizedSnapshot: LatestLedgerReconciliationResult = latestLedgerResponseSchema.parse({
  metric: 'latest_ledger',
  value: 500,
  status: 'verified',
  confidence: 1,
  confidence_formula_version: 'latest-ledger-confidence-v0.2',
  confidence_components: { agreement: 1, freshness: 1, availability: 1, diversity: 1, spread: 1 },
  confidence_caps_applied: [],
  sources_configured: 2,
  sources_responded: 2,
  sources_usable: 2,
  sources_agreeing: 2,
  sources_excluded: 0,
  observations: [],
  discrepancies: [],
  source_errors: [],
  as_of: '2026-08-10T10:00:00.000Z',
  methodology_version: 'latest-ledger-v0.2',
})

describe('GET /api/v1/stellar/latest-ledger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    readModel.load.mockReset()
  })

  it('serves the latest finalized snapshot without waiting for an upstream request', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    readModel.load.mockResolvedValue(finalizedSnapshot)

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(finalizedSnapshot)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(readModel.load).toHaveBeenCalledOnce()
  })

  it('returns unavailable when no finalized snapshot exists', async () => {
    readModel.load.mockResolvedValue(null)

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ metric: 'latest_ledger', value: null, status: 'unavailable' })
    expect(body.source_errors[0]).toMatchObject({
      code: 'invalid_configuration',
      message: 'No finalized latest-ledger snapshot is available',
    })
    expect(latestLedgerResponseSchema.parse(body)).toEqual(body)
  })

  it('returns a sanitized unavailable response when the read store fails', async () => {
    readModel.load.mockRejectedValue(new Error('postgres://user:secret@db.internal/axiom'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.source_errors[0]).toMatchObject({
      code: 'invalid_configuration',
      message: 'The latest-ledger read model is temporarily unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('secret')
  })
})
