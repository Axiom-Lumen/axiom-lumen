import type { Metadata } from 'next'
import { DocSection, FigureRow, PageHero } from '../../components/site'
import { loadPublicOperationalStatus, type OperationalLevel, type OperationalStatus } from '../../lib/db/operational-status'
import { errorTelemetry, structuredLog } from '../../lib/observability/telemetry'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'System status',
  description: 'Current Axiom Lumen ingestion, source, freshness, and reconciliation health from persisted telemetry.',
}

const labels: Record<OperationalLevel, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  outage: 'Service disruption',
}

function fallbackStatus(): OperationalStatus {
  const generatedAt = new Date().toISOString()
  return {
    status: 'outage', generatedAt, windowSeconds: 0,
    metrics: {
      retrievalLatencyMs: { average: null, maximum: null }, retrievals: { total: 0, failures: 0, failurePercent: 0 },
      freshness: { trackedSnapshots: 0, staleSnapshots: 0, maximumAgeRatio: null, unavailable: 0 },
      cycles: { completed: 0, failed: 0, pending: 0, running: 0, maximumLagSeconds: null },
      sources: { tracked: 0, unhealthy: 0, stale: 0, openCircuits: 0, oldestObservationAgeSeconds: null }, discrepancies: { open: 0, warning: 0, critical: 0 },
    },
    components: [{ name: 'Telemetry store', status: 'outage', detail: 'Persisted health is temporarily unavailable' }],
    alerts: [{ code: 'telemetry_unavailable', level: 'critical', message: 'Persisted health is temporarily unavailable', value: 1, threshold: 1 }],
  }
}

export default async function StatusPage() {
  let status: OperationalStatus
  try {
    status = await loadPublicOperationalStatus()
  } catch (error) {
    structuredLog('error', 'public_status_read_failed', errorTelemetry(error))
    status = fallbackStatus()
  }
  return <OperationalStatusView status={status} />
}

function OperationalStatusView({ status }: { status: OperationalStatus }) {
  return (
    <main>
      <PageHero docCode="AL-OPS-01 · SYSTEM STATUS" kicker="Persisted operational health" title={labels[status.status]}>
        This page is generated from persisted ingestion cycles, source-health observations, snapshot freshness,
        and reconciliation state. Last evaluated {new Date(status.generatedAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC.
      </PageHero>
      <DocSection num="01" label="Current" title="Measured service signals." wide>
        <FigureRow figures={[
          { value: status.metrics.freshness.maximumAgeRatio === null ? 'No data' : `${Math.round(status.metrics.freshness.maximumAgeRatio * 100)}%`, label: 'Maximum freshness budget' },
          { value: `${status.metrics.retrievals.failurePercent}%`, label: 'Retrieval failures' },
          { value: String(status.metrics.sources.unhealthy), label: 'Unhealthy sources' },
          { value: String(status.metrics.discrepancies.critical), label: 'Critical discrepancies' },
        ]} />
      </DocSection>
      <DocSection num="02" label="Components" title="Operational breakdown." wide>
        <div className="border-t border-linesoft">
          {status.components.map((component) => (
            <div key={component.name} className="grid gap-2 border-b border-linesoft py-5 sm:grid-cols-[220px_150px_1fr]">
              <div className="font-serif text-lg">{component.name}</div>
              <div className="font-mono text-xs uppercase tracking-widest text-gold">{labels[component.status]}</div>
              <div className="text-sm text-muted">{component.detail}</div>
            </div>
          ))}
        </div>
      </DocSection>
      <DocSection num="03" label="Alerts" title={status.alerts.length === 0 ? 'No active threshold alerts.' : 'Active threshold alerts.'}>
        {status.alerts.length > 0 && (
          <ul className="space-y-4">
            {status.alerts.map((alert) => (
              <li key={alert.code} className="border-l border-golddim pl-5 text-sm text-muted">
                <span className="font-mono text-xs uppercase tracking-widest text-gold">{alert.level}</span>
                <span className="ml-4">{alert.message} ({alert.value} / {alert.threshold})</span>
              </li>
            ))}
          </ul>
        )}
      </DocSection>
    </main>
  )
}
