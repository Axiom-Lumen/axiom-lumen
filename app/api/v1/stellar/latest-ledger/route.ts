import { NextResponse } from 'next/server'
import { loadLatestLedgerReadModel } from '../../../../../lib/db/latest-ledger-read-model'
import {
  LATEST_LEDGER_CONFIDENCE_FORMULA_VERSION,
  LATEST_LEDGER_METHODOLOGY_VERSION,
  latestLedgerResponseSchema,
} from '../../../../../lib/reconcile/latest-ledger'

export const dynamic = 'force-dynamic'

function unavailableResponse(message: string, sourcesConfigured = 0) {
  const asOf = new Date().toISOString()
  return NextResponse.json(
    latestLedgerResponseSchema.parse({
      metric: 'latest_ledger',
      value: null,
      status: 'unavailable',
      confidence: 0,
      confidence_formula_version: LATEST_LEDGER_CONFIDENCE_FORMULA_VERSION,
      confidence_components: {
        agreement: 0,
        freshness: 0,
        availability: 0,
        diversity: 0,
        spread: 0,
      },
      confidence_caps_applied: [],
      sources_configured: sourcesConfigured,
      sources_responded: 0,
      sources_usable: 0,
      sources_agreeing: 0,
      sources_excluded: 0,
      observations: [],
      discrepancies: [],
      source_errors: [
        {
          sourceId: 'configuration',
          sourceUrl: '',
          code: 'invalid_configuration',
          message,
          retrievedAt: asOf,
        },
      ],
      as_of: asOf,
      methodology_version: LATEST_LEDGER_METHODOLOGY_VERSION,
    }),
    { status: 503 },
  )
}

export async function GET() {
  try {
    const reconciled = await loadLatestLedgerReadModel()
    if (!reconciled) return unavailableResponse('No finalized latest-ledger snapshot is available')
    return NextResponse.json(reconciled, { status: reconciled.status === 'unavailable' ? 503 : 200 })
  } catch (error) {
    console.error('Unable to load the latest-ledger read model', {
      name: error instanceof Error ? error.name : 'Error',
    })
    return unavailableResponse('The latest-ledger read model is temporarily unavailable')
  }
}
