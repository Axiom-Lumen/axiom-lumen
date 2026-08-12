import { describe, expect, it } from 'vitest'
import { planAnchorCase, replyDueAt } from '../../lib/anchor/case-workflow'

const warning = {
  discrepancyId: 'discrepancy-1',
  sourceId: 'anchor-source-1',
  methodologyVersion: 'anchor-reserve-comparison-v0.1',
  namedParty: true,
  severity: 'warning' as const,
  lifecycleState: 'open' as const,
  publicationState: 'internal' as const,
  replyReviewState: 'not_required' as const,
  consecutiveCycles: 1,
  consecutiveAboveInfoCycles: 1,
  firstObservedAt: '2026-08-12T10:00:00.000Z',
  lastObservedAt: '2026-08-12T10:00:00.000Z',
  lastFinalizedCycleAt: '2026-08-12T10:00:00.000Z',
  lastFinalizedCycleId: 'cycle-1',
  publicationUpdatedAt: '2026-08-12T10:00:00.000Z',
}

describe('anchor case planning', () => {
  it('creates deterministic notices while leaving the reply clock stopped', () => {
    const input = {
      anchorId: 'anchor-1',
      discrepancyState: warning,
      triggeringEventId: 'event-1',
      contacts: [
        { id: 'webhook-1', kind: 'webhook' as const, verifiedAt: '2026-08-12T09:00:00.000Z' },
        { id: 'email-1', kind: 'email' as const, verifiedAt: '2026-08-12T09:00:00.000Z' },
      ],
      openedAt: '2026-08-12T10:01:00.000Z',
    }
    const first = planAnchorCase(input)
    const second = planAnchorCase({ ...input, contacts: [...input.contacts].reverse() })

    expect(first).toEqual(second)
    expect(first.caseRecord).toMatchObject({ status: 'draft', replyDueAt: null })
    expect(first.notifications.map((notice) => notice.channel)).toEqual(['email', 'webhook'])
    expect(first.notifications.every((notice) => /^[0-9a-f]{64}$/.test(notice.payloadSha256))).toBe(true)
    expect(first.notifications[0]?.payload).toMatchObject({
      version: 'anchor-discrepancy-notice-v0.1',
      severity: 'warning',
      responseWindowHours: 72,
    })
  })

  it('rejects ineligible discrepancies and unverified contacts', () => {
    expect(() => planAnchorCase({
      anchorId: 'anchor-1',
      discrepancyState: { ...warning, severity: 'info', consecutiveAboveInfoCycles: 0 },
      triggeringEventId: 'event-1',
      contacts: [{ id: 'email-1', kind: 'email', verifiedAt: '2026-08-12T09:00:00.000Z' }],
      openedAt: '2026-08-12T10:01:00.000Z',
    })).toThrow(/Warning or Critical/)
    expect(() => planAnchorCase({
      anchorId: 'anchor-1',
      discrepancyState: warning,
      triggeringEventId: 'event-1',
      contacts: [],
      openedAt: '2026-08-12T10:01:00.000Z',
    })).toThrow(/at least one verified/)
  })

  it('starts the 72-hour deadline from successful delivery time', () => {
    expect(replyDueAt('2026-08-12T10:01:00.000Z')).toBe('2026-08-15T10:01:00.000Z')
  })
})
