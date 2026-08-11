import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  ReconciliationDashboard,
  ReconciliationDashboardLoading,
} from '../../components/dashboard/reconciliation-dashboard'
import { ReconciliationDashboardView } from '../../components/dashboard/reconciliation-dashboard-view'
import { apiReconciliationSnapshotSchema } from '../../lib/contracts'
import {
  DEFAULT_ASSET,
  createIllustrativeSupplyArtifact,
  type ConfidenceArtifactState,
} from '../../lib/home/confidence-artifact'

const AS_OF = '2026-08-11T12:00:00.000Z'

function snapshotState(status: 'verified' | 'degraded' = 'verified'): ConfidenceArtifactState {
  const snapshot = apiReconciliationSnapshotSchema.parse({
    ...createIllustrativeSupplyArtifact(),
    status,
    value: { kind: 'amount', value: '48213091.02' },
    confidence: status === 'verified' ? 0.94 : 0.58,
    confidence_components: { agreement: 0.9, freshness: 0.8, availability: 0.5, diversity: 1, spread: 0.95 },
    confidence_caps_applied: status === 'degraded' ? ['partial_availability'] : [],
    sources_configured: 3,
    sources_responded: 2,
    sources_usable: 1,
    sources_agreeing: 1,
    sources_excluded: 1,
    contributions: [{
      observation_id: 'observation_horizon',
      source_id: 'public_horizon',
      source_class: 'canonical_ledger',
      age_seconds: 8.25,
      effective_weight: 0.712,
      agrees: true,
    }],
    source_errors: [{
      source_id: 'archive_source',
      source_url: null,
      code: 'request_failed',
      category: 'transport',
      message: 'Archive evidence could not be retrieved',
      occurred_at: AS_OF,
      retryable: true,
    }],
    discrepancies: [{
      id: 'discrepancy_public_1',
      source_id: 'public_horizon',
      severity: 'warning',
      lifecycle_state: 'open',
      publication_state: 'approved_public',
      consecutive_cycles: 2,
      observed_value: { kind: 'amount', value: '48213090' },
      reference_value: { kind: 'amount', value: '48213091.02' },
      first_observed_at: '2026-08-11T11:00:00.000Z',
      last_observed_at: AS_OF,
    }],
    as_of: AS_OF,
  })
  return { kind: status, asset: DEFAULT_ASSET, snapshot }
}

function render(state: ConfidenceArtifactState) {
  return renderToStaticMarkup(
    <ReconciliationDashboardView
      initialState={state}
      endpoint={`/api/v1/supply/${encodeURIComponent(DEFAULT_ASSET)}`}
    />,
  )
}

describe('reconciliation dashboard', () => {
  it('renders a validated server-loaded snapshot', async () => {
    const state = snapshotState()
    const load = vi.fn(async () => state)
    const markup = renderToStaticMarkup(await ReconciliationDashboard({ load }))

    expect(load).toHaveBeenCalledOnce()
    expect(markup).toContain('Verified')
    expect(markup).toContain('48,213,091.02')
    expect(markup).toContain('94%')
    expect(markup).toContain('Aug 11, 2026')
  })

  it('renders confidence, partial-source, failure, and approved discrepancy context', () => {
    const markup = render(snapshotState('degraded'))

    expect(markup).toContain('Confidence explanation')
    expect(markup).toContain('agreement')
    expect(markup).toContain('partial_availability')
    expect(markup).toContain('public_horizon')
    expect(markup).toContain('8.3s')
    expect(markup).toContain('0.712')
    expect(markup).toContain('Archive evidence could not be retrieved')
    expect(markup).toContain('Approved discrepancy intervals')
    expect(markup).toContain('not the complete append-only event history')
    expect(markup).toContain('warning · open')
    expect(markup).toContain('approved_public')
    expect(markup).toContain('Individual readings and excluded-source identities are not exposed')
  })

  it.each([
    [{ kind: 'empty', asset: DEFAULT_ASSET } as ConfidenceArtifactState, 'No finalized snapshot', 'The API has no finalized snapshot'],
    [{ kind: 'error', asset: DEFAULT_ASSET, reason: 'request_failed' } as ConfidenceArtifactState, 'Request failed', 'current API request could not be completed'],
    [{ kind: 'stale', asset: DEFAULT_ASSET, snapshot: createIllustrativeSupplyArtifact() } as ConfidenceArtifactState, 'Stale — not current', 'not current'],
    [{ kind: 'unavailable', asset: DEFAULT_ASSET, response: createIllustrativeSupplyArtifact() } as ConfidenceArtifactState, 'Unavailable', 'does not contain a usable reconciled value'],
  ])('renders explicit non-live state %#', (state, label, explanation) => {
    const markup = render(state)
    expect(markup).toContain(label)
    expect(markup).toContain(explanation)
    expect(markup).toContain('Not available')
  })

  it('provides a responsive loading state and accessible refresh behavior', () => {
    const loading = renderToStaticMarkup(<ReconciliationDashboardLoading />)
    expect(loading).toContain('Loading current reconciliation')
    expect(loading).toContain('role="status"')
    expect(loading).toContain('aria-live="polite"')

    const markup = render(snapshotState())
    expect(markup).toContain('sm:grid-cols-2')
    expect(markup).toContain('lg:grid-cols-4')
    expect(markup).toContain('overflow-x-auto')
    expect(markup).toContain('<button')
    expect(markup).toContain('Refresh snapshot')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-atomic="true"')
    expect(markup).toContain('href="/methodology"')
  })

  it('derives dashboard data from the API loader without database imports', () => {
    for (const file of [
      'components/dashboard/reconciliation-dashboard.tsx',
      'components/dashboard/reconciliation-dashboard-view.tsx',
      'app/dashboard/page.tsx',
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(source).not.toMatch(/lib\/db|drizzle|postgres/i)
    }
  })

  it('is linked from desktop/mobile navigation and the document index', () => {
    expect(readFileSync(resolve(process.cwd(), 'components/nav.tsx'), 'utf8')).toContain("href: '/dashboard'")
    expect(readFileSync(resolve(process.cwd(), 'components/footer.tsx'), 'utf8')).toContain("href: '/dashboard'")
  })
})
