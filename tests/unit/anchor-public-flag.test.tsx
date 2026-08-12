import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PublicAnchorFlagView } from '../../components/anchor/public-flag'
import type { PublicAnchorFlag } from '../../lib/db/anchor-public-read-model'

describe('public anchor flag rendering', () => {
  it('escapes claimant text and makes corrections at least as prominent as the response', () => {
    const flag: PublicAnchorFlag = {
      flagId: 'flag-a', anchor: 'Anchor A', severity: 'warning', lifecycleState: 'open',
      publicationState: 'withheld', methodologyVersion: 'anchor-v1',
      firstObservedAt: '2026-08-12T10:00:00.000Z', lastObservedAt: '2026-08-12T10:00:00.000Z',
      response: {
        body: '<script>steal()</script>', version: 1,
        submittedAt: '2026-08-12T10:01:00.000Z', reviewedAt: '2026-08-12T10:02:00.000Z', evidence: [],
      },
      disputes: [],
      corrections: [{
        id: 'correction-a', targetEventId: 'event-a', type: 'retracted',
        reason: '<img src=x onerror=steal()>', replacement: { correctedDeviationBand: 'info' },
        occurredAt: '2026-08-12T10:03:00.000Z',
      }],
    }

    const markup = renderToStaticMarkup(<PublicAnchorFlagView flag={flag} />)
    expect(markup).toContain('Corrections and retractions')
    expect(markup.indexOf('Corrections and retractions')).toBeLessThan(markup.indexOf('Anchor response'))
    expect(markup).toContain('&lt;script&gt;steal()&lt;/script&gt;')
    expect(markup).toContain('&lt;img src=x onerror=steal()&gt;')
    expect(markup).not.toContain('<script>')
    expect(markup).not.toContain('<img')
    expect(markup).toContain('Corrected deviation: info')
  })

  it('does not render a non-HTTPS evidence href even if an unsafe value reaches the view', () => {
    const flag: PublicAnchorFlag = {
      flagId: 'flag-b', anchor: 'Anchor B', severity: 'warning', lifecycleState: 'open',
      publicationState: 'approved_public', methodologyVersion: 'anchor-v1',
      firstObservedAt: '2026-08-12T10:00:00.000Z', lastObservedAt: '2026-08-12T10:00:00.000Z',
      response: {
        body: 'Response', version: 1, submittedAt: '2026-08-12T10:01:00.000Z', reviewedAt: '2026-08-12T10:02:00.000Z',
        evidence: [{ id: 'unsafe', kind: 'link' as const, url: 'javascript:steal()' }],
      }, disputes: [], corrections: [],
    }
    const markup = renderToStaticMarkup(<PublicAnchorFlagView flag={flag} />)
    expect(markup).toContain('Unavailable evidence link')
    expect(markup).not.toContain('href=')
    expect(markup).not.toContain('javascript:')
  })
})
