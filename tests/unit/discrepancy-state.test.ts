import { describe, expect, it } from 'vitest'
import {
  advanceDiscrepancyState,
  appendDiscrepancyAmendment,
  classifyMeasurementSeverity,
  classifySafeIntegerDeviationBand,
  classifyStellarAmountDeviationBand,
  transitionDiscrepancyPublication,
  type PersistedDiscrepancyState,
} from '../../lib/reconcile/discrepancy-state'
import { parseStellarAmount } from '../../lib/stellar/amount'

const timestamp = (second: number) => `2026-08-09T12:00:${String(second).padStart(2, '0')}.000Z`
const cycle = (number: number, absoluteDeviation: number, tolerance = 1) => ({
  cycleId: `cycle-${number}`,
  completedAt: timestamp(number),
  deviationBand: classifySafeIntegerDeviationBand({ absoluteDeviation, tolerance }),
})

function advance(
  priorState: PersistedDiscrepancyState | null,
  cycleNumber: number,
  absoluteDeviation: number,
  options: { namedParty?: boolean; discrepancyId?: string } = {},
) {
  return advanceDiscrepancyState({
    priorState,
    discrepancyId: options.discrepancyId ?? 'disc-1',
    sourceId: 'source-1',
    namedParty: options.namedParty ?? false,
    cycle: cycle(cycleNumber, absoluteDeviation),
  })
}

describe('measurement severity', () => {
  it('uses inclusive lower-severity boundaries', () => {
    expect(classifySafeIntegerDeviationBand({ absoluteDeviation: 1, tolerance: 1 })).toBe('within_tolerance')
    expect(classifySafeIntegerDeviationBand({ absoluteDeviation: 2, tolerance: 1 })).toBe('info')
    expect(classifySafeIntegerDeviationBand({ absoluteDeviation: 3, tolerance: 1 })).toBe('above_info')
  })

  it('requires three consecutive above-Info cycles for Critical', () => {
    expect(classifyMeasurementSeverity({ deviationBand: 'above_info', consecutiveAboveInfoCycles: 1 })).toBe('warning')
    expect(classifyMeasurementSeverity({ deviationBand: 'above_info', consecutiveAboveInfoCycles: 2 })).toBe('warning')
    expect(classifyMeasurementSeverity({ deviationBand: 'above_info', consecutiveAboveInfoCycles: 3 })).toBe('critical')
  })

  it('classifies Stellar amount boundaries without number coercion', () => {
    expect(
      classifyStellarAmountDeviationBand({
        absoluteDeviation: parseStellarAmount('9007199254740993.0000001'),
        tolerance: parseStellarAmount('9007199254740993.0000001'),
      }),
    ).toBe('within_tolerance')
    expect(
      classifyStellarAmountDeviationBand({
        absoluteDeviation: parseStellarAmount('2.0000000'),
        tolerance: parseStellarAmount('1.0000000'),
      }),
    ).toBe('info')
    expect(
      classifyStellarAmountDeviationBand({
        absoluteDeviation: parseStellarAmount('2.0000001'),
        tolerance: parseStellarAmount('1.0000000'),
      }),
    ).toBe('above_info')
  })
})

describe('stateful discrepancy cycles', () => {
  it('opens, observes, and escalates deterministically over three cycles', () => {
    const first = advance(null, 1, 3)
    const second = advance(first.state, 2, 3)
    const third = advance(second.state, 3, 3)

    expect(first.events.map((event) => event.type)).toEqual(['opened'])
    expect(second.events.map((event) => event.type)).toEqual(['observed'])
    expect(third.events.map((event) => event.type)).toEqual(['escalated'])
    expect(third.state).toMatchObject({
      severity: 'critical',
      lifecycleState: 'open',
      consecutiveCycles: 3,
      consecutiveAboveInfoCycles: 3,
    })
  })

  it('resets only the above-Info streak when an Info cycle interrupts it', () => {
    const first = advance(null, 1, 3)
    const info = advance(first.state, 2, 2)
    const warning = advance(info.state, 3, 3)

    expect(info.state).toMatchObject({ severity: 'info', consecutiveCycles: 2, consecutiveAboveInfoCycles: 0 })
    expect(warning.state).toMatchObject({ severity: 'warning', consecutiveCycles: 3, consecutiveAboveInfoCycles: 1 })
  })

  it('ignores duplicate and out-of-order finalized cycles without changing persistence', () => {
    const first = advance(null, 2, 3)
    if (!first.state) throw new Error('expected state')

    const duplicate = advanceDiscrepancyState({
      priorState: first.state,
      discrepancyId: 'disc-1',
      sourceId: 'source-1',
      namedParty: false,
      cycle: { ...cycle(3, 0), cycleId: 'cycle-2' },
    })
    const late = advance(first.state, 1, 0)

    expect(duplicate).toEqual({ state: first.state, events: [], ignoredReason: 'duplicate_cycle' })
    expect(late).toEqual({ state: first.state, events: [], ignoredReason: 'out_of_order_cycle' })
    expect(first.state.consecutiveCycles).toBe(1)
  })

  it('appends reconvergence and resolution events instead of deleting the open history', () => {
    const opened = advance(null, 1, 3)
    const resolved = advance(opened.state, 2, 1)

    expect(opened.events[0]?.type).toBe('opened')
    expect(resolved.events.map((event) => event.type)).toEqual(['reconverged', 'resolved'])
    expect(resolved.events.every((event) => event.before?.lifecycleState === 'open')).toBe(true)
    expect(resolved.state).toMatchObject({ lifecycleState: 'resolved', consecutiveCycles: 0 })
  })

  it('opens a new occurrence after a resolved discrepancy deviates again', () => {
    const opened = advance(null, 1, 3)
    const resolved = advance(opened.state, 2, 0)
    const reopened = advance(resolved.state, 3, 3, { discrepancyId: 'disc-2' })

    expect(reopened.events[0]).toMatchObject({ type: 'opened', discrepancyId: 'disc-2' })
    expect(reopened.state).toMatchObject({ discrepancyId: 'disc-2', firstObservedAt: timestamp(3) })
  })

  it('rejects malformed persisted state before advancing a cycle', () => {
    const opened = advance(null, 1, 3)
    if (!opened.state) throw new Error('expected state')
    const invalidState = { ...opened.state, consecutiveCycles: -1 }

    expect(() => advance(invalidState, 2, 3)).toThrow(/greater than or equal to 0/)
  })

  it('rejects a persisted named-party public state that bypassed reply review', () => {
    const opened = advance(null, 1, 3, { namedParty: true })
    if (!opened.state) throw new Error('expected state')
    const invalidState = { ...opened.state, publicationState: 'approved_public' as const }

    expect(() => advance(invalidState, 2, 3, { namedParty: true })).toThrow(/completed reply review/)
  })

  it('generates distinct event IDs for identifiers whose delimiter forms would collide', () => {
    const first = advanceDiscrepancyState({
      discrepancyId: 'a:b',
      sourceId: 'source-1',
      namedParty: false,
      cycle: { ...cycle(1, 3), cycleId: 'c' },
    })
    const second = advanceDiscrepancyState({
      discrepancyId: 'a',
      sourceId: 'source-1',
      namedParty: false,
      cycle: { ...cycle(1, 3), cycleId: 'b:c' },
    })

    expect(first.events[0]?.eventId).not.toBe(second.events[0]?.eventId)
  })
})

describe('publication safeguards', () => {
  it('keeps Info discrepancies internal even with a human approval action', () => {
    const opened = advance(null, 1, 2)
    if (!opened.state) throw new Error('expected state')
    const state = opened.state

    expect(() =>
      transitionDiscrepancyPublication({
        state,
        action: { type: 'approve', eventId: 'pub-1', occurredAt: timestamp(2), reviewerId: 'reviewer-1' },
      }),
    ).toThrow(/must remain internal/)
  })

  it('places a named-party Warning into pending reply automatically', () => {
    const result = advance(null, 1, 3, { namedParty: true })

    expect(result.state).toMatchObject({
      severity: 'warning',
      publicationState: 'pending_reply',
      replyReviewState: 'awaiting_reply',
    })
  })

  it('cannot approve a named-party record before reply review completes', () => {
    const opened = advance(null, 1, 3, { namedParty: true })
    if (!opened.state) throw new Error('expected state')
    const state = opened.state

    expect(() =>
      transitionDiscrepancyPublication({
        state,
        action: { type: 'approve', eventId: 'pub-1', occurredAt: timestamp(2), reviewerId: 'reviewer-1' },
      }),
    ).toThrow(/reviewed response or expired reply window/)
  })

  it('allows human approval after a response is received and reviewed', () => {
    const opened = advance(null, 1, 3, { namedParty: true })
    if (!opened.state) throw new Error('expected state')
    const received = transitionDiscrepancyPublication({
      state: opened.state,
      action: { type: 'record_response', eventId: 'pub-1', occurredAt: timestamp(2) },
    })
    const reviewed = transitionDiscrepancyPublication({
      state: received.state,
      action: { type: 'review_response', eventId: 'pub-2', occurredAt: timestamp(3), reviewerId: 'reviewer-1' },
    })
    const approved = transitionDiscrepancyPublication({
      state: reviewed.state,
      action: { type: 'approve', eventId: 'pub-3', occurredAt: timestamp(4), reviewerId: 'reviewer-2' },
    })

    expect(approved.state.publicationState).toBe('approved_public')
    expect(approved.event).toMatchObject({ action: 'approve', reviewerId: 'reviewer-2' })
  })

  it('allows human approval after an unanswered reply window expires', () => {
    const opened = advance(null, 1, 3, { namedParty: true })
    if (!opened.state) throw new Error('expected state')
    const expired = transitionDiscrepancyPublication({
      state: opened.state,
      action: { type: 'expire_reply_window', eventId: 'pub-1', occurredAt: '2026-08-12T12:00:01.000Z' },
    })
    const approved = transitionDiscrepancyPublication({
      state: expired.state,
      action: { type: 'approve', eventId: 'pub-2', occurredAt: '2026-08-12T12:00:02.000Z', reviewerId: 'reviewer-1' },
    })

    expect(expired.state.replyReviewState).toBe('window_expired')
    expect(approved.state.publicationState).toBe('approved_public')
  })

  it('cannot mark a reply window expired before the configured duration', () => {
    const opened = advance(null, 1, 3, { namedParty: true })
    if (!opened.state) throw new Error('expected state')
    const state = opened.state

    expect(() =>
      transitionDiscrepancyPublication({
        state,
        action: { type: 'expire_reply_window', eventId: 'pub-1', occurredAt: '2026-08-12T12:00:00.000Z' },
      }),
    ).toThrow(/has not expired/)
  })

  it('starts reply review when a named-party Info escalates to Warning', () => {
    const info = advance(null, 1, 2, { namedParty: true })
    const warning = advance(info.state, 2, 3, { namedParty: true })

    expect(info.state).toMatchObject({ publicationState: 'internal', replyReviewState: 'not_required' })
    expect(warning.state).toMatchObject({ publicationState: 'pending_reply', replyReviewState: 'awaiting_reply' })
  })

  it('returns an approved open discrepancy to internal when its measurement drops to Info', () => {
    const warning = advance(null, 1, 3)
    if (!warning.state) throw new Error('expected state')
    const approved = transitionDiscrepancyPublication({
      state: warning.state,
      action: { type: 'approve', eventId: 'pub-1', occurredAt: timestamp(2), reviewerId: 'reviewer-1' },
    })
    const info = advance(approved.state, 3, 2)

    expect(info.state).toMatchObject({
      severity: 'info',
      publicationState: 'internal',
      replyReviewState: 'not_required',
    })
    expect(info.events[0]).toMatchObject({
      before: { publicationState: 'approved_public' },
      after: { publicationState: 'internal' },
    })
  })
})

describe('append-only amendments', () => {
  it('records corrections and retractions as replay-required events', () => {
    const opened = advance(null, 1, 3)
    if (!opened.state) throw new Error('expected state')
    const correction = appendDiscrepancyAmendment({
      state: opened.state,
      eventId: 'amendment-1',
      targetEvent: opened.events[0]!,
      type: 'corrected',
      occurredAt: timestamp(2),
      reason: 'Corrected source payload',
      correctedDeviationBand: 'within_tolerance',
    })
    const retraction = appendDiscrepancyAmendment({
      state: opened.state,
      eventId: 'amendment-2',
      targetEvent: opened.events[0]!,
      type: 'retracted',
      occurredAt: timestamp(3),
      reason: 'Observation invalidated',
    })

    expect(correction).toMatchObject({
      type: 'corrected',
      requiresReplay: true,
      correctedDeviationBand: 'within_tolerance',
    })
    expect(retraction).toMatchObject({ type: 'retracted', requiresReplay: true })
    expect(opened.events[0]?.type).toBe('opened')
  })

  it('rejects an amendment target from another discrepancy context', () => {
    const opened = advance(null, 1, 3)
    if (!opened.state || !opened.events[0]) throw new Error('expected state and event')
    const state = opened.state
    const targetEvent = { ...opened.events[0], discrepancyId: 'different-discrepancy' }

    expect(() =>
      appendDiscrepancyAmendment({
        state,
        eventId: 'amendment-1',
        targetEvent,
        type: 'retracted',
        occurredAt: timestamp(2),
        reason: 'Wrong target',
      }),
    ).toThrow(/same discrepancy, source, and methodology/)
  })
})
