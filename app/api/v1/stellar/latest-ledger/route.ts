import { NextResponse } from 'next/server'
import {
  LATEST_LEDGER_CONFIDENCE_FORMULA_VERSION,
  LATEST_LEDGER_METHODOLOGY_VERSION,
  reconcileLatestLedger,
} from '../../../../../lib/reconcile/latest-ledger'
import { fetchLatestLedgersFromHorizonSources, parseHorizonSources } from '../../../../../lib/stellar/horizon'

export const dynamic = 'force-dynamic'

function unavailableResponse(message: string, sourcesConfigured = 0) {
  return NextResponse.json(
    {
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
          retrievedAt: new Date().toISOString(),
        },
      ],
      as_of: new Date().toISOString(),
      methodology_version: LATEST_LEDGER_METHODOLOGY_VERSION,
    },
    { status: 503 },
  )
}

export async function GET() {
  let sources
  try {
    sources = parseHorizonSources(process.env.STELLAR_HORIZON_URLS)
  } catch (error) {
    return unavailableResponse(error instanceof Error ? error.message : 'Invalid Horizon sources')
  }

  if (sources.length === 0) {
    return unavailableResponse('STELLAR_HORIZON_URLS must include at least one HTTP or HTTPS URL')
  }

  const latestLedgers = await fetchLatestLedgersFromHorizonSources({ sources })
  const reconciled = reconcileLatestLedger({
    observations: latestLedgers.observations,
    sourceErrors: latestLedgers.source_errors,
    sourcesConfigured: latestLedgers.sources_configured,
    sourcesExcluded: latestLedgers.sources_excluded,
  })

  return NextResponse.json(reconciled, {
    status: reconciled.status === 'unavailable' ? 503 : 200,
  })
}
