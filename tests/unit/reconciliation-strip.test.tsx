import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ReconciliationStrip } from '../../components/ui/home/reconciliation-strip'
import {
  RECONCILIATION_REFRESH_INTERVAL_MS,
  ReconciliationStripView,
} from '../../components/ui/home/reconciliation-strip-view'
import { apiReconciliationSnapshotSchema } from '../../lib/contracts'
import {
  DEFAULT_ASSET,
  createIllustrativeSupplyArtifact,
  type ConfidenceArtifactState,
} from '../../lib/home/confidence-artifact'

function availableState(status: 'verified' | 'degraded'): ConfidenceArtifactState {
  const snapshot = apiReconciliationSnapshotSchema.parse({
    ...createIllustrativeSupplyArtifact(),
    status,
    value: { kind: 'amount', value: '48213091.02' },
    confidence: status === 'verified' ? 0.94 : 0.61,
    sources_configured: 3,
    sources_responded: 2,
    sources_usable: 2,
    sources_agreeing: status === 'verified' ? 2 : 1,
    sources_excluded: 1,
    contributions: [
      {
        observation_id: 'observation_horizon',
        source_id: 'public_horizon',
        source_class: 'canonical_ledger',
        age_seconds: 9.4,
        effective_weight: 0.8,
        agrees: true,
      },
      {
        observation_id: 'observation_archive',
        source_id: 'trusted_archive',
        source_class: 'archive',
        age_seconds: 11,
        effective_weight: 0.7,
        agrees: status === 'verified',
      },
    ],
  })
  return { kind: status, asset: DEFAULT_ASSET, snapshot }
}

function render(state: ConfidenceArtifactState) {
  return renderToStaticMarkup(
    <ReconciliationStripView
      initialState={state}
      endpoint={`/api/v1/supply/${encodeURIComponent(DEFAULT_ASSET)}`}
    />,
  )
}

describe('homepage reconciliation strip', () => {
  it('server-renders the validated initial snapshot', async () => {
    const state = availableState('verified')
    const load = vi.fn(async () => state)
    const markup = renderToStaticMarkup(await ReconciliationStrip({ load }))

    expect(load).toHaveBeenCalledOnce()
    expect(markup).toContain('Verified persisted snapshot')
    expect(markup).toContain('48,213,091.02')
    expect(markup).toContain('94%')
    expect(markup).toContain('2 usable / 3 configured')
    expect(markup).toContain('Aug 10, 2026')
  })

  it('shows safe contribution context without inventing per-source values', () => {
    const markup = render(availableState('degraded'))

    expect(markup).toContain('Degraded persisted snapshot')
    expect(markup).toContain('public_horizon')
    expect(markup).toContain('canonical ledger · agrees · age 9s')
    expect(markup).toContain('trusted_archive')
    expect(markup).toContain('archive · differs · age 11s')
    expect(markup).toContain('Individual source values are omitted')
    expect(markup.match(/48,213,091\.02/g)).toHaveLength(1)
  })

  it.each([
    [{ kind: 'empty', asset: DEFAULT_ASSET } as ConfidenceArtifactState, 'No finalized snapshot'],
    [{ kind: 'error', asset: DEFAULT_ASSET, reason: 'request_failed' } as ConfidenceArtifactState, 'Persisted snapshot could not be loaded'],
    [{ kind: 'stale', asset: DEFAULT_ASSET, snapshot: createIllustrativeSupplyArtifact() } as ConfidenceArtifactState, 'Stale snapshot — not current'],
    [{ kind: 'unavailable', asset: DEFAULT_ASSET, response: createIllustrativeSupplyArtifact() } as ConfidenceArtifactState, 'Current snapshot unavailable'],
  ])('renders the %s failure state without a fabricated value', (state, label) => {
    const markup = render(state)

    expect(markup).toContain(label)
    expect(markup).toContain('Not available')
    expect(markup).not.toContain('48,213,091.02')
  })

  it('is responsive, keyboard-operable, and uses a restrained live region', () => {
    const markup = render(availableState('verified'))

    expect(RECONCILIATION_REFRESH_INTERVAL_MS).toBe(60_000)
    expect(markup).toContain('sm:grid-cols-2')
    expect(markup).toContain('lg:grid-cols-')
    expect(markup).toContain('<button')
    expect(markup).toContain('Refresh now')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('aria-atomic="true"')
    expect(markup).toContain('class="sr-only"')
  })

  it('omits browser refresh controls when hosted authentication is required', () => {
    const markup = renderToStaticMarkup(<ReconciliationStripView initialState={availableState('verified')} endpoint="/api/v1/supply/example" refreshEnabled={false} />)
    expect(markup).not.toContain('Refresh now')
  })
})
