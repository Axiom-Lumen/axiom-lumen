import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const statusStore = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../../lib/db/operational-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/db/operational-status')>()),
  loadPublicOperationalStatus: statusStore.load,
}))
vi.mock('../../components/site', () => ({
  PageHero: ({ title, children }: { title: string; children: React.ReactNode }) => <header><h1>{title}</h1>{children}</header>,
  DocSection: ({ title, children }: { title: string; children: React.ReactNode }) => <section><h2>{title}</h2>{children}</section>,
  FigureRow: ({ figures }: { figures: Array<{ value: string; label: string }> }) => (
    <dl>{figures.map((figure) => <div key={figure.label}><dt>{figure.label}</dt><dd>{figure.value}</dd></div>)}</dl>
  ),
}))

import StatusPage from '../../app/status/page'

const publicStatus = {
  status: 'degraded' as const,
  generatedAt: '2026-08-13T12:00:00.000Z',
  windowSeconds: 900,
  metrics: {
    retrievalLatencyMs: { average: 100, maximum: 200 },
    retrievals: { total: 10, failures: 1, failurePercent: 10 },
    freshness: { trackedSnapshots: 4, staleSnapshots: 1, maximumAgeRatio: 1.25, unavailable: 0 },
    cycles: { completed: 8, failed: 0, pending: 0, running: 1, maximumLagSeconds: 45 },
    sources: { tracked: 5, unhealthy: 1, stale: 1, openCircuits: 0, oldestObservationAgeSeconds: 190 },
    discrepancies: { open: 1, warning: 1, critical: 0 },
  },
  components: [{ name: 'Data freshness', status: 'degraded' as const, detail: '4 persisted snapshot subjects tracked' }],
  alerts: [{ code: 'snapshot_freshness', level: 'warning' as const, message: 'Maximum snapshot age is above the warning threshold', value: 125, threshold: 100 }],
}

describe('public operational status page', () => {
  afterEach(() => statusStore.load.mockReset())

  it('renders persisted public health with explicit status and freshness context', async () => {
    statusStore.load.mockResolvedValue(publicStatus)
    const html = renderToStaticMarkup(await StatusPage())
    expect(html).toContain('Degraded')
    expect(html).toContain('125%')
    expect(html).toContain('Data freshness')
    expect(html).not.toContain('source-a')
  })

  it('renders a safe outage state when persisted health cannot be read', async () => {
    statusStore.load.mockRejectedValue(new Error('postgres://user:secret@db.internal/private'))
    const html = renderToStaticMarkup(await StatusPage())
    expect(html).toContain('Service disruption')
    expect(html).toContain('Persisted health is temporarily unavailable')
    expect(html).not.toContain('secret')
  })
})
