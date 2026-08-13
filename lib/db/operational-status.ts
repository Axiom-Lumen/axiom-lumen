import { z } from 'zod'
import {
  depthReconciliationMethodologyConfig,
  supplyMethodologyConfig,
  trustlineMethodologyConfig,
} from '../../config/methodology'
import type { DatabaseClient } from './client'

export type OperationalLevel = 'operational' | 'degraded' | 'outage'

export interface OperationalThresholds {
  windowSeconds: number
  cacheSeconds: number
  latencyWarningMs: number
  latencyCriticalMs: number
  failureWarningPercent: number
  failureCriticalPercent: number
  latestLedgerMaximumAgeSeconds: number
  freshnessWarningPercent: number
  freshnessCriticalPercent: number
  sourceHealthWarningSeconds: number
  sourceHealthCriticalSeconds: number
  cycleLagWarningSeconds: number
  cycleLagCriticalSeconds: number
  unhealthySourcesWarning: number
  unhealthySourcesCritical: number
  criticalDiscrepanciesWarning: number
  criticalDiscrepanciesCritical: number
}

export interface OperationalAlert {
  code: string
  level: 'warning' | 'critical'
  message: string
  value: number
  threshold: number
}

export interface OperationalStatus {
  status: OperationalLevel
  generatedAt: string
  windowSeconds: number
  metrics: {
    retrievalLatencyMs: { average: number | null; maximum: number | null }
    retrievals: { total: number; failures: number; failurePercent: number }
    freshness: { trackedSnapshots: number; staleSnapshots: number; maximumAgeRatio: number | null; unavailable: number }
    cycles: { completed: number; failed: number; pending: number; running: number; maximumLagSeconds: number | null }
    sources: { tracked: number; unhealthy: number; stale: number; openCircuits: number; oldestObservationAgeSeconds: number | null }
    discrepancies: { open: number; warning: number; critical: number }
  }
  components: Array<{ name: string; status: OperationalLevel; detail: string }>
  alerts: OperationalAlert[]
}

const positiveInteger = (name: string, raw: string | undefined, fallback: number, maximum = 86_400_000) => {
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`)
  }
  return parsed
}

function thresholdPair(name: string, warning: number, critical: number) {
  if (critical <= warning) throw new Error(`${name} critical threshold must exceed its warning threshold`)
}

export function parseOperationalThresholds(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OperationalThresholds {
  const thresholds = {
    windowSeconds: positiveInteger('OPS_STATUS_WINDOW_SECONDS', environment.OPS_STATUS_WINDOW_SECONDS, 900, 86_400),
    cacheSeconds: positiveInteger('OPS_STATUS_CACHE_SECONDS', environment.OPS_STATUS_CACHE_SECONDS, 5, 300),
    latencyWarningMs: positiveInteger('OPS_LATENCY_WARNING_MS', environment.OPS_LATENCY_WARNING_MS, 2_000),
    latencyCriticalMs: positiveInteger('OPS_LATENCY_CRITICAL_MS', environment.OPS_LATENCY_CRITICAL_MS, 5_000),
    failureWarningPercent: positiveInteger('OPS_FAILURE_WARNING_PERCENT', environment.OPS_FAILURE_WARNING_PERCENT, 10, 99),
    failureCriticalPercent: positiveInteger('OPS_FAILURE_CRITICAL_PERCENT', environment.OPS_FAILURE_CRITICAL_PERCENT, 25, 100),
    latestLedgerMaximumAgeSeconds: positiveInteger('OPS_LATEST_LEDGER_MAXIMUM_AGE_SECONDS', environment.OPS_LATEST_LEDGER_MAXIMUM_AGE_SECONDS, 120, 86_400),
    freshnessWarningPercent: positiveInteger('OPS_FRESHNESS_WARNING_PERCENT', environment.OPS_FRESHNESS_WARNING_PERCENT, 100, 10_000),
    freshnessCriticalPercent: positiveInteger('OPS_FRESHNESS_CRITICAL_PERCENT', environment.OPS_FRESHNESS_CRITICAL_PERCENT, 300, 10_000),
    sourceHealthWarningSeconds: positiveInteger('OPS_SOURCE_HEALTH_WARNING_SECONDS', environment.OPS_SOURCE_HEALTH_WARNING_SECONDS, 180, 86_400),
    sourceHealthCriticalSeconds: positiveInteger('OPS_SOURCE_HEALTH_CRITICAL_SECONDS', environment.OPS_SOURCE_HEALTH_CRITICAL_SECONDS, 600, 604_800),
    cycleLagWarningSeconds: positiveInteger('OPS_CYCLE_LAG_WARNING_SECONDS', environment.OPS_CYCLE_LAG_WARNING_SECONDS, 120, 86_400),
    cycleLagCriticalSeconds: positiveInteger('OPS_CYCLE_LAG_CRITICAL_SECONDS', environment.OPS_CYCLE_LAG_CRITICAL_SECONDS, 300, 604_800),
    unhealthySourcesWarning: positiveInteger('OPS_UNHEALTHY_SOURCES_WARNING', environment.OPS_UNHEALTHY_SOURCES_WARNING, 1, 10_000),
    unhealthySourcesCritical: positiveInteger('OPS_UNHEALTHY_SOURCES_CRITICAL', environment.OPS_UNHEALTHY_SOURCES_CRITICAL, 3, 10_000),
    criticalDiscrepanciesWarning: positiveInteger('OPS_CRITICAL_DISCREPANCIES_WARNING', environment.OPS_CRITICAL_DISCREPANCIES_WARNING, 1, 10_000),
    criticalDiscrepanciesCritical: positiveInteger('OPS_CRITICAL_DISCREPANCIES_CRITICAL', environment.OPS_CRITICAL_DISCREPANCIES_CRITICAL, 3, 10_000),
  }
  thresholdPair('latency', thresholds.latencyWarningMs, thresholds.latencyCriticalMs)
  thresholdPair('failure', thresholds.failureWarningPercent, thresholds.failureCriticalPercent)
  thresholdPair('freshness', thresholds.freshnessWarningPercent, thresholds.freshnessCriticalPercent)
  thresholdPair('source health age', thresholds.sourceHealthWarningSeconds, thresholds.sourceHealthCriticalSeconds)
  thresholdPair('cycle lag', thresholds.cycleLagWarningSeconds, thresholds.cycleLagCriticalSeconds)
  thresholdPair('unhealthy sources', thresholds.unhealthySourcesWarning, thresholds.unhealthySourcesCritical)
  thresholdPair('critical discrepancies', thresholds.criticalDiscrepanciesWarning, thresholds.criticalDiscrepanciesCritical)
  return thresholds
}

const aggregateRowSchema = z.object({
  retrieval_total: z.coerce.number().int().nonnegative(),
  retrieval_failures: z.coerce.number().int().nonnegative(),
  latency_average: z.coerce.number().nonnegative().nullable(),
  latency_maximum: z.coerce.number().nonnegative().nullable(),
  snapshots_tracked: z.coerce.number().int().nonnegative(),
  stale_snapshots: z.coerce.number().int().nonnegative(),
  maximum_snapshot_age_ratio: z.coerce.number().nonnegative().nullable(),
  snapshots_unavailable: z.coerce.number().int().nonnegative(),
  cycles_completed: z.coerce.number().int().nonnegative(),
  cycles_failed: z.coerce.number().int().nonnegative(),
  cycles_pending: z.coerce.number().int().nonnegative(),
  cycles_running: z.coerce.number().int().nonnegative(),
  maximum_cycle_lag: z.coerce.number().nonnegative().nullable(),
  sources_tracked: z.coerce.number().int().nonnegative(),
  sources_unhealthy: z.coerce.number().int().nonnegative(),
  sources_stale: z.coerce.number().int().nonnegative(),
  oldest_source_observation_age: z.coerce.number().nonnegative().nullable(),
  circuits_open: z.coerce.number().int().nonnegative(),
  discrepancies_open: z.coerce.number().int().nonnegative(),
  discrepancies_warning: z.coerce.number().int().nonnegative(),
  discrepancies_critical: z.coerce.number().int().nonnegative(),
}).strict()

function addThresholdAlert(
  alerts: OperationalAlert[],
  input: { code: string; label: string; value: number | null; warning: number; critical: number },
) {
  if (input.value === null || input.value < input.warning) return
  const critical = input.value >= input.critical
  alerts.push({
    code: input.code,
    level: critical ? 'critical' : 'warning',
    message: `${input.label} is ${critical ? 'above the critical' : 'above the warning'} threshold`,
    value: Number(input.value.toFixed(3)),
    threshold: critical ? input.critical : input.warning,
  })
}

function componentStatus(alerts: OperationalAlert[], codes: readonly string[]): OperationalLevel {
  const matching = alerts.filter((alert) => codes.includes(alert.code))
  if (matching.some((alert) => alert.level === 'critical')) return 'outage'
  return matching.length > 0 ? 'degraded' : 'operational'
}

export function createOperationalStatusRepository(client: DatabaseClient) {
  return {
    async read(
      now = new Date(),
      thresholds = parseOperationalThresholds(),
      visibility: 'public' | 'internal' = 'internal',
    ): Promise<OperationalStatus> {
      if (!Number.isFinite(now.getTime())) throw new Error('operational status clock must be valid')
      const result = await client.pool.query({
        text: `
          WITH recent_attempts AS (
            SELECT outcome, EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 AS latency_ms
            FROM retrieval_attempts WHERE completed_at >= $1::timestamptz - ($2::int * interval '1 second')
          ), latest_snapshots AS (
            SELECT DISTINCT ON (metric, subject_key) metric, status, as_of,
              CASE metric
                WHEN 'latest_ledger' THEN $3::int
                WHEN 'circulating_supply' THEN $4::int
                WHEN 'order_book_depth' THEN $5::int
                WHEN 'trustline_count' THEN $6::int
              END AS maximum_age_seconds
            FROM reconciliation_snapshots
            WHERE metric <> 'anchor_reserves'
            ORDER BY metric, subject_key, as_of DESC, id DESC
          ), recent_cycles AS (
            SELECT status, scheduled_at, completed_at FROM ingest_cycles
            WHERE scheduled_at >= $1::timestamptz - ($2::int * interval '1 second')
          ), recent_terminal_leases AS (
            SELECT status, scheduled_at FROM scheduled_cycle_leases
            WHERE scheduled_at >= $1::timestamptz - ($2::int * interval '1 second')
          ), active_leases AS (
            SELECT status, scheduled_at FROM scheduled_cycle_leases WHERE status IN ('pending', 'running')
          ), active_source_health AS (
            SELECT definitions.id, health.state, health.circuit_state, health.last_observed_at
            FROM source_definitions definitions
            LEFT JOIN source_health_states health ON health.source_id = definitions.id
            WHERE definitions.enabled
          )
          SELECT
            (SELECT count(*) FROM recent_attempts)::int AS retrieval_total,
            (SELECT count(*) FROM recent_attempts WHERE outcome = 'failure')::int AS retrieval_failures,
            (SELECT round(avg(latency_ms)::numeric, 3) FROM recent_attempts) AS latency_average,
            (SELECT round(max(latency_ms)::numeric, 3) FROM recent_attempts) AS latency_maximum,
            (SELECT count(*) FROM latest_snapshots)::int AS snapshots_tracked,
            (SELECT count(*) FROM latest_snapshots WHERE GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - as_of))) >= maximum_age_seconds)::int AS stale_snapshots,
            (SELECT max(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - as_of))) / maximum_age_seconds) FROM latest_snapshots) AS maximum_snapshot_age_ratio,
            (SELECT count(*) FROM latest_snapshots WHERE status = 'unavailable')::int AS snapshots_unavailable,
            (SELECT count(*) FROM recent_cycles WHERE status = 'completed')::int AS cycles_completed,
            (SELECT count(*) FROM recent_terminal_leases WHERE status IN ('failed', 'abandoned'))::int AS cycles_failed,
            (SELECT count(*) FROM active_leases WHERE status = 'pending')::int AS cycles_pending,
            (SELECT count(*) FROM active_leases WHERE status = 'running')::int AS cycles_running,
            (SELECT max(lag_seconds) FROM (
              SELECT EXTRACT(EPOCH FROM (completed_at - scheduled_at)) AS lag_seconds
              FROM recent_cycles WHERE completed_at IS NOT NULL
              UNION ALL
              SELECT GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - scheduled_at))) AS lag_seconds
              FROM active_leases
            ) cycle_lags) AS maximum_cycle_lag,
            (SELECT count(*) FROM active_source_health)::int AS sources_tracked,
            (SELECT count(*) FROM active_source_health WHERE state IS NULL OR state <> 'healthy')::int AS sources_unhealthy,
            (SELECT count(*) FROM active_source_health WHERE last_observed_at IS NULL OR EXTRACT(EPOCH FROM ($1::timestamptz - last_observed_at)) >= $7::int)::int AS sources_stale,
            (SELECT max(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - last_observed_at)))) FROM active_source_health) AS oldest_source_observation_age,
            (SELECT count(*) FROM active_source_health WHERE circuit_state = 'open')::int AS circuits_open,
            (SELECT count(*) FROM discrepancies WHERE lifecycle_state = 'open' AND ($8::boolean OR publication_state = 'approved_public'))::int AS discrepancies_open,
            (SELECT count(*) FROM discrepancies WHERE lifecycle_state = 'open' AND severity = 'warning' AND ($8::boolean OR publication_state = 'approved_public'))::int AS discrepancies_warning,
            (SELECT count(*) FROM discrepancies WHERE lifecycle_state = 'open' AND severity = 'critical' AND ($8::boolean OR publication_state = 'approved_public'))::int AS discrepancies_critical
        `,
        values: [
          now.toISOString(), thresholds.windowSeconds, thresholds.latestLedgerMaximumAgeSeconds,
          supplyMethodologyConfig.maximumObservationAgeSeconds,
          depthReconciliationMethodologyConfig.maximumObservationAgeSeconds,
          trustlineMethodologyConfig.maximumObservationAgeSeconds,
          thresholds.sourceHealthWarningSeconds,
          visibility === 'internal',
        ],
      })
      const row = aggregateRowSchema.parse(result.rows[0])
      const failurePercent = row.retrieval_total === 0 ? 0 : (row.retrieval_failures / row.retrieval_total) * 100
      const alerts: OperationalAlert[] = []
      addThresholdAlert(alerts, { code: 'retrieval_latency', label: 'Maximum retrieval latency', value: row.latency_maximum, warning: thresholds.latencyWarningMs, critical: thresholds.latencyCriticalMs })
      addThresholdAlert(alerts, { code: 'retrieval_failures', label: 'Retrieval failure rate', value: failurePercent, warning: thresholds.failureWarningPercent, critical: thresholds.failureCriticalPercent })
      addThresholdAlert(alerts, { code: 'snapshot_freshness', label: 'Maximum snapshot age percentage', value: row.maximum_snapshot_age_ratio === null ? null : row.maximum_snapshot_age_ratio * 100, warning: thresholds.freshnessWarningPercent, critical: thresholds.freshnessCriticalPercent })
      addThresholdAlert(alerts, { code: 'cycle_lag', label: 'Maximum cycle lag', value: row.maximum_cycle_lag, warning: thresholds.cycleLagWarningSeconds, critical: thresholds.cycleLagCriticalSeconds })
      addThresholdAlert(alerts, { code: 'source_health', label: 'Unhealthy source count', value: row.sources_unhealthy, warning: thresholds.unhealthySourcesWarning, critical: thresholds.unhealthySourcesCritical })
      addThresholdAlert(alerts, { code: 'source_health_stale', label: 'Oldest source-health observation age', value: row.oldest_source_observation_age, warning: thresholds.sourceHealthWarningSeconds, critical: thresholds.sourceHealthCriticalSeconds })
      addThresholdAlert(alerts, { code: 'critical_discrepancies', label: 'Open critical discrepancy count', value: row.discrepancies_critical, warning: thresholds.criticalDiscrepanciesWarning, critical: thresholds.criticalDiscrepanciesCritical })
      if (row.snapshots_tracked === 0) alerts.push({ code: 'telemetry_initializing', level: 'warning', message: 'No persisted snapshots are available yet', value: 0, threshold: 1 })
      if (row.snapshots_unavailable > 0) alerts.push({ code: 'snapshots_unavailable', level: 'warning', message: 'One or more latest snapshots are unavailable', value: row.snapshots_unavailable, threshold: 1 })
      if (row.cycles_failed > 0) alerts.push({ code: 'cycle_failures', level: 'warning', message: 'One or more scheduler cycles failed in the observation window', value: row.cycles_failed, threshold: 1 })
      const status: OperationalLevel = alerts.some((alert) => alert.level === 'critical')
        ? 'outage'
        : alerts.length > 0 ? 'degraded' : 'operational'
      return {
        status,
        generatedAt: now.toISOString(),
        windowSeconds: thresholds.windowSeconds,
        metrics: {
          retrievalLatencyMs: { average: row.latency_average, maximum: row.latency_maximum },
          retrievals: { total: row.retrieval_total, failures: row.retrieval_failures, failurePercent: Number(failurePercent.toFixed(3)) },
          freshness: { trackedSnapshots: row.snapshots_tracked, staleSnapshots: row.stale_snapshots, maximumAgeRatio: row.maximum_snapshot_age_ratio, unavailable: row.snapshots_unavailable },
          cycles: { completed: row.cycles_completed, failed: row.cycles_failed, pending: row.cycles_pending, running: row.cycles_running, maximumLagSeconds: row.maximum_cycle_lag },
          sources: { tracked: row.sources_tracked, unhealthy: row.sources_unhealthy, stale: row.sources_stale, openCircuits: row.circuits_open, oldestObservationAgeSeconds: row.oldest_source_observation_age },
          discrepancies: { open: row.discrepancies_open, warning: row.discrepancies_warning, critical: row.discrepancies_critical },
        },
        components: [
          { name: 'Data freshness', status: componentStatus(alerts, ['snapshot_freshness', 'snapshots_unavailable', 'telemetry_initializing']), detail: `${row.snapshots_tracked} persisted snapshot subjects tracked` },
          { name: 'Ingestion pipeline', status: componentStatus(alerts, ['retrieval_latency', 'retrieval_failures', 'cycle_lag', 'cycle_failures']), detail: `${row.cycles_completed} cycles completed in the observation window` },
          { name: 'Source connectivity', status: componentStatus(alerts, ['source_health', 'source_health_stale']), detail: `${row.sources_unhealthy} unhealthy and ${row.sources_stale} stale of ${row.sources_tracked} enabled sources` },
          { name: 'Reconciliation', status: componentStatus(alerts, ['critical_discrepancies']), detail: `${row.discrepancies_open} open discrepancies` },
        ],
        alerts,
      }
    },
  }
}

let webProcessClient: DatabaseClient | undefined
const statusCache = new Map<'public' | 'internal', { expiresAt: number; value: OperationalStatus }>()

async function loadStatus(visibility: 'public' | 'internal', now: Date) {
  const thresholds = parseOperationalThresholds()
  const cached = statusCache.get(visibility)
  if (cached && cached.expiresAt > now.getTime()) return cached.value
  const { createDatabaseClient } = await import('./client')
  webProcessClient ??= createDatabaseClient()
  const value = await createOperationalStatusRepository(webProcessClient).read(now, thresholds, visibility)
  statusCache.set(visibility, { expiresAt: now.getTime() + thresholds.cacheSeconds * 1_000, value })
  return value
}

export async function loadOperationalStatus(now = new Date()) {
  return loadStatus('internal', now)
}

export async function loadPublicOperationalStatus(now = new Date()) {
  return loadStatus('public', now)
}

export async function checkOperationalReadiness() {
  const { createDatabaseClient } = await import('./client')
  webProcessClient ??= createDatabaseClient()
  parseOperationalThresholds()
  const result = await webProcessClient.pool.query<{ ready: boolean }>(
    `SELECT to_regclass('public.retrieval_attempts') IS NOT NULL
      AND to_regclass('public.reconciliation_snapshots') IS NOT NULL
      AND to_regclass('public.ingest_cycles') IS NOT NULL
      AND to_regclass('public.scheduled_cycle_leases') IS NOT NULL
      AND to_regclass('public.source_definitions') IS NOT NULL
      AND to_regclass('public.source_health_states') IS NOT NULL
      AND to_regclass('public.discrepancies') IS NOT NULL AS ready`,
  )
  if (result.rows[0]?.ready !== true) throw new Error('operational telemetry tables are unavailable')
}
