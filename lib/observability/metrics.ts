import type { OperationalStatus } from '../db/operational-status'

function metric(name: string, help: string, value: number) {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${Number.isFinite(value) ? value : 0}`
}

export function renderOperationalMetrics(status: OperationalStatus) {
  const metrics = status.metrics
  return [
    metric('axiom_operational_status', 'Overall status: 1 operational, 0.5 degraded, 0 outage', status.status === 'operational' ? 1 : status.status === 'degraded' ? 0.5 : 0),
    metric('axiom_retrieval_latency_average_milliseconds', 'Average retrieval latency in the observation window', metrics.retrievalLatencyMs.average ?? 0),
    metric('axiom_retrieval_latency_maximum_milliseconds', 'Maximum retrieval latency in the observation window', metrics.retrievalLatencyMs.maximum ?? 0),
    metric('axiom_retrieval_failures_window', 'Failed retrieval attempts in the observation window', metrics.retrievals.failures),
    metric('axiom_retrieval_failure_percent', 'Failed retrieval percentage in the observation window', metrics.retrievals.failurePercent),
    metric('axiom_snapshot_maximum_age_ratio', 'Maximum snapshot age divided by its metric-specific freshness limit', metrics.freshness.maximumAgeRatio ?? 0),
    metric('axiom_cycle_maximum_lag_seconds', 'Maximum completed-cycle lag in the observation window', metrics.cycles.maximumLagSeconds ?? 0),
    metric('axiom_cycles_failed_window', 'Failed or abandoned cycles in the observation window', metrics.cycles.failed),
    metric('axiom_sources_unhealthy', 'Current unhealthy source count', metrics.sources.unhealthy),
    metric('axiom_sources_stale', 'Enabled sources with missing or stale health observations', metrics.sources.stale),
    metric('axiom_source_circuits_open', 'Current open source circuit count', metrics.sources.openCircuits),
    metric('axiom_discrepancies_open', 'Current open discrepancy count', metrics.discrepancies.open),
    metric('axiom_discrepancies_critical', 'Current open critical discrepancy count', metrics.discrepancies.critical),
  ].join('\n\n') + '\n'
}
