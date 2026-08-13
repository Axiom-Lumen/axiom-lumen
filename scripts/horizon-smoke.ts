import {
  fetchLatestLedgersFromHorizonSources,
  parseHorizonHostList,
  parseHorizonSources,
} from '../lib/stellar/horizon'

const sources = parseHorizonSources(process.env.STELLAR_HORIZON_URLS, {
  allowedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_ALLOWED_HOSTS),
  deniedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_DENIED_HOSTS),
})
if (sources.length === 0) throw new Error('STELLAR_HORIZON_URLS must configure at least one scheduled smoke source')

const result = await fetchLatestLedgersFromHorizonSources({ sources })
if (result.observations.length === 0 || result.source_errors.length > 0) {
  throw new Error(`Horizon smoke failed: ${result.observations.length} observations, ${result.source_errors.length} errors`)
}

process.stdout.write(`${JSON.stringify({
  checked_at: result.retrieved_at,
  sources_configured: result.sources_configured,
  observations: result.observations.map(({ sourceId, ledgerSequence, closedAt }) => ({
    source_id: sourceId,
    ledger_sequence: ledgerSequence,
    closed_at: closedAt,
  })),
})}\n`)
