import { NextResponse } from 'next/server'
import {
  LATEST_LEDGER_CONFIDENCE_FORMULA_VERSION,
  LATEST_LEDGER_METHODOLOGY_VERSION,
  latestLedgerResponseSchema,
  reconcileLatestLedger,
} from '../../../../../lib/reconcile/latest-ledger'
import {
  PUBLIC_NETWORK_PASSPHRASE,
  fetchLatestLedgersFromHorizonSources,
  parseHorizonHostList,
  parseHorizonSources,
} from '../../../../../lib/stellar/horizon'

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
  let sources
  try {
    sources = parseHorizonSources(process.env.STELLAR_HORIZON_URLS, {
      allowedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_ALLOWED_HOSTS),
      deniedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_DENIED_HOSTS),
    })
  } catch (error) {
    return unavailableResponse(error instanceof Error ? error.message : 'Invalid Horizon sources')
  }

  if (sources.length === 0) {
    return unavailableResponse('STELLAR_HORIZON_URLS must include at least one HTTP or HTTPS URL')
  }

  const latestLedgers = await fetchLatestLedgersFromHorizonSources({
    sources,
    expectedNetworkPassphrase: PUBLIC_NETWORK_PASSPHRASE,
  })
  const reconciled = reconcileLatestLedger({
    observations: latestLedgers.observations,
    sourceErrors: latestLedgers.source_errors,
    sourcesConfigured: latestLedgers.sources_configured,
    sourcesExcluded: latestLedgers.sources_excluded,
    asOf: new Date(latestLedgers.retrieved_at),
    network: { id: 'public', passphrase: latestLedgers.network_passphrase },
  })

  return NextResponse.json(reconciled, {
    status: reconciled.status === 'unavailable' ? 503 : 200,
  })
}
