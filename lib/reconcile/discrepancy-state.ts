import { methodologyConfig } from '../../config/methodology'
import {
  identifierSchema,
  persistedDiscrepancyStateSchema,
  type PersistedDiscrepancyState as ValidatedPersistedDiscrepancyState,
} from '../contracts/domain'
import { StellarAmount } from '../stellar/amount'

export const DEFAULT_REPLY_WINDOW_HOURS = methodologyConfig.publication.replyWindowHours
export const DISCREPANCY_METHODOLOGY_VERSION = methodologyConfig.version

export type MeasurementSeverity = 'info' | 'warning' | 'critical'
export type DeviationBand = 'within_tolerance' | 'info' | 'above_info'
export type DiscrepancyLifecycleState = 'open' | 'resolved'
export type DiscrepancyPublicationState = 'internal' | 'pending_reply' | 'approved_public' | 'withheld'
export type ReplyReviewState =
  | 'not_required'
  | 'awaiting_reply'
  | 'response_received'
  | 'response_reviewed'
  | 'window_expired'

export type PersistedDiscrepancyState = ValidatedPersistedDiscrepancyState

export type DiscrepancyMeasurementEventType =
  | 'opened'
  | 'observed'
  | 'escalated'
  | 'reconverged'
  | 'resolved'

export interface DiscrepancyStateSnapshot {
  severity: MeasurementSeverity
  lifecycleState: DiscrepancyLifecycleState
  publicationState: DiscrepancyPublicationState
  replyReviewState: ReplyReviewState
  consecutiveCycles: number
  consecutiveAboveInfoCycles: number
}

export interface DiscrepancyMeasurementEvent {
  eventId: string
  type: DiscrepancyMeasurementEventType
  discrepancyId: string
  sourceId: string
  methodologyVersion: string
  cycleId: string
  occurredAt: string
  deviationBand: DeviationBand
  before: DiscrepancyStateSnapshot | null
  after: DiscrepancyStateSnapshot
}

export interface DiscrepancyAmendmentEvent {
  eventId: string
  type: 'corrected' | 'retracted'
  discrepancyId: string
  sourceId: string
  methodologyVersion: string
  targetEventId: string
  occurredAt: string
  reason: string
  correctedDeviationBand?: DeviationBand
  requiresReplay: true
}

export interface DiscrepancyPublicationEvent {
  eventId: string
  type: 'publication_changed'
  discrepancyId: string
  sourceId: string
  methodologyVersion: string
  occurredAt: string
  action: PublicationAction['type']
  notificationId?: string
  reviewerId?: string
  before: Pick<PersistedDiscrepancyState, 'publicationState' | 'replyReviewState'>
  after: Pick<PersistedDiscrepancyState, 'publicationState' | 'replyReviewState'>
}

export type DiscrepancyEvent =
  | DiscrepancyMeasurementEvent
  | DiscrepancyAmendmentEvent
  | DiscrepancyPublicationEvent

export interface CompletedDiscrepancyCycle {
  cycleId: string
  completedAt: string
  deviationBand: DeviationBand
}

export interface AdvanceDiscrepancyResult {
  state: PersistedDiscrepancyState | null
  events: DiscrepancyMeasurementEvent[]
  ignoredReason?: 'duplicate_cycle' | 'out_of_order_cycle'
}

export type PublicationAction =
  | { type: 'begin_reply'; eventId: string; occurredAt: string; notificationId: string }
  | { type: 'record_response'; eventId: string; occurredAt: string }
  | { type: 'review_response'; eventId: string; occurredAt: string; reviewerId: string }
  | { type: 'expire_reply_window'; eventId: string; occurredAt: string }
  | { type: 'approve'; eventId: string; occurredAt: string; reviewerId: string }
  | { type: 'withhold'; eventId: string; occurredAt: string; reviewerId: string }

function assertIdentifier(name: string, value: string) {
  const result = identifierSchema.safeParse(value)
  if (!result.success) throw new Error(`${name} must be a valid identifier`)
}

function assertNonEmpty(name: string, value: string) {
  if (!value.trim()) throw new Error(`${name} must not be empty`)
}

function parseUtc(name: string, value: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC timestamp`)
  }
  return timestamp
}

function assertDeviationBand(name: string, value: string): asserts value is DeviationBand {
  if (!['within_tolerance', 'info', 'above_info'].includes(value)) {
    throw new Error(`${name} must be within_tolerance, info, or above_info`)
  }
}

function snapshot(state: PersistedDiscrepancyState): DiscrepancyStateSnapshot {
  return {
    severity: state.severity,
    lifecycleState: state.lifecycleState,
    publicationState: state.publicationState,
    replyReviewState: state.replyReviewState,
    consecutiveCycles: state.consecutiveCycles,
    consecutiveAboveInfoCycles: state.consecutiveAboveInfoCycles,
  }
}

function eventId(discrepancyId: string, cycleId: string, type: DiscrepancyMeasurementEventType) {
  return `d${discrepancyId.length}:${discrepancyId}:c${cycleId.length}:${cycleId}:${type}`
}

export function classifyMeasurementSeverity({
  deviationBand,
  consecutiveAboveInfoCycles,
}: {
  deviationBand: DeviationBand
  consecutiveAboveInfoCycles: number
}): MeasurementSeverity | null {
  assertDeviationBand('deviationBand', deviationBand)
  if (!Number.isSafeInteger(consecutiveAboveInfoCycles) || consecutiveAboveInfoCycles < 0) {
    throw new Error('consecutiveAboveInfoCycles must be a non-negative safe integer')
  }
  if (deviationBand === 'within_tolerance') return null
  if (deviationBand === 'info') return 'info'
  return consecutiveAboveInfoCycles >= 3 ? 'critical' : 'warning'
}

export function classifySafeIntegerDeviationBand({
  absoluteDeviation,
  tolerance,
}: {
  absoluteDeviation: number
  tolerance: number
}): DeviationBand {
  if (!Number.isSafeInteger(absoluteDeviation) || absoluteDeviation < 0) {
    throw new Error('absoluteDeviation must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) {
    throw new Error('tolerance must be a non-negative safe integer')
  }
  if (absoluteDeviation <= tolerance) return 'within_tolerance'
  if (BigInt(absoluteDeviation) <= BigInt(tolerance) * 2n) return 'info'
  return 'above_info'
}

export function classifyStellarAmountDeviationBand({
  absoluteDeviation,
  tolerance,
}: {
  absoluteDeviation: StellarAmount
  tolerance: StellarAmount
}): DeviationBand {
  if (absoluteDeviation.isNegative() || tolerance.isNegative()) {
    throw new Error('absoluteDeviation and tolerance must not be negative')
  }
  if (absoluteDeviation.compare(tolerance) <= 0) return 'within_tolerance'
  if (absoluteDeviation.compare(tolerance.add(tolerance)) <= 0) return 'info'
  return 'above_info'
}

function initialPublication(at: string) {
  return {
    publicationState: 'internal' as const,
    replyReviewState: 'not_required' as const,
    publicationUpdatedAt: at,
  }
}

/** Advances state only for a strictly newer completed cycle. Returned events are append-only facts. */
export function advanceDiscrepancyState({
  priorState,
  discrepancyId,
  sourceId,
  namedParty,
  methodologyVersion = DISCREPANCY_METHODOLOGY_VERSION,
  cycle,
}: {
  priorState?: PersistedDiscrepancyState | null
  discrepancyId: string
  sourceId: string
  namedParty: boolean
  methodologyVersion?: string
  cycle: CompletedDiscrepancyCycle
}): AdvanceDiscrepancyResult {
  priorState = priorState ? persistedDiscrepancyStateSchema.parse(priorState) : null
  assertIdentifier('discrepancyId', discrepancyId)
  assertIdentifier('sourceId', sourceId)
  assertIdentifier('methodologyVersion', methodologyVersion)
  assertIdentifier('cycle.cycleId', cycle.cycleId)
  const completedAtMs = parseUtc('cycle.completedAt', cycle.completedAt)
  assertDeviationBand('cycle.deviationBand', cycle.deviationBand)

  if (priorState) {
    if (priorState.sourceId !== sourceId || priorState.namedParty !== namedParty) {
      throw new Error('source identity and named-party attribution cannot change across persisted state')
    }
    if (priorState.lifecycleState === 'open' && priorState.methodologyVersion !== methodologyVersion) {
      throw new Error('an open discrepancy must retain its methodologyVersion')
    }
    if (priorState.lifecycleState === 'open' && priorState.discrepancyId !== discrepancyId) {
      throw new Error('an open discrepancy must retain its discrepancyId')
    }
    if (cycle.cycleId === priorState.lastFinalizedCycleId) {
      return { state: priorState, events: [], ignoredReason: 'duplicate_cycle' }
    }
    if (completedAtMs <= parseUtc('priorState.lastFinalizedCycleAt', priorState.lastFinalizedCycleAt)) {
      return { state: priorState, events: [], ignoredReason: 'out_of_order_cycle' }
    }
  }

  const withinTolerance = cycle.deviationBand === 'within_tolerance'
  if (!priorState && withinTolerance) return { state: null, events: [] }

  if (priorState?.lifecycleState === 'open' && withinTolerance) {
    const before = snapshot(priorState)
    const state = persistedDiscrepancyStateSchema.parse({
      ...priorState,
      lifecycleState: 'resolved',
      consecutiveCycles: 0,
      consecutiveAboveInfoCycles: 0,
      lastObservedAt: cycle.completedAt,
      lastFinalizedCycleAt: cycle.completedAt,
      lastFinalizedCycleId: cycle.cycleId,
    })
    const after = snapshot(state)
    return {
      state,
      events: (['reconverged', 'resolved'] as const).map((type) => ({
        eventId: eventId(state.discrepancyId, cycle.cycleId, type),
        type,
        discrepancyId: state.discrepancyId,
        sourceId: state.sourceId,
        methodologyVersion: state.methodologyVersion,
        cycleId: cycle.cycleId,
        occurredAt: cycle.completedAt,
        deviationBand: cycle.deviationBand,
        before,
        after,
      })),
    }
  }

  if (priorState?.lifecycleState === 'resolved' && withinTolerance) {
    return {
      state: persistedDiscrepancyStateSchema.parse({
        ...priorState,
        lastFinalizedCycleAt: cycle.completedAt,
        lastFinalizedCycleId: cycle.cycleId,
      }),
      events: [],
    }
  }

  const continuingState = priorState?.lifecycleState === 'open' ? priorState : null
  const continuing = continuingState !== null
  const consecutiveCycles = continuingState ? continuingState.consecutiveCycles + 1 : 1
  const aboveInfoBand = cycle.deviationBand === 'above_info'
  const consecutiveAboveInfoCycles = aboveInfoBand
    ? continuing
      ? continuingState.consecutiveAboveInfoCycles + 1
      : 1
    : 0
  const severity = classifyMeasurementSeverity({
    deviationBand: cycle.deviationBand,
    consecutiveAboveInfoCycles,
  })
  if (!severity) throw new Error('out-of-tolerance cycle must have a severity')

  const publication = continuing
    ? {
        publicationState: continuingState.publicationState,
        replyReviewState: continuingState.replyReviewState,
        publicationUpdatedAt: continuingState.publicationUpdatedAt,
      }
    : initialPublication(cycle.completedAt)
  if (continuing && severity === 'info') {
    publication.publicationState = 'internal'
    publication.replyReviewState = 'not_required'
    publication.publicationUpdatedAt = cycle.completedAt
  }

  const state = persistedDiscrepancyStateSchema.parse({
    discrepancyId: continuingState ? continuingState.discrepancyId : discrepancyId,
    sourceId,
    methodologyVersion,
    namedParty,
    severity,
    lifecycleState: 'open',
    ...publication,
    consecutiveCycles,
    consecutiveAboveInfoCycles,
    firstObservedAt: continuingState ? continuingState.firstObservedAt : cycle.completedAt,
    lastObservedAt: cycle.completedAt,
    lastFinalizedCycleAt: cycle.completedAt,
    lastFinalizedCycleId: cycle.cycleId,
  })
  const before = continuingState ? snapshot(continuingState) : null
  const previousRank = continuingState ? ['info', 'warning', 'critical'].indexOf(continuingState.severity) : -1
  const nextRank = ['info', 'warning', 'critical'].indexOf(severity)
  const type: DiscrepancyMeasurementEventType = !continuing
    ? 'opened'
    : nextRank > previousRank
      ? 'escalated'
      : 'observed'

  return {
    state,
    events: [
      {
        eventId: eventId(state.discrepancyId, cycle.cycleId, type),
        type,
        discrepancyId: state.discrepancyId,
        sourceId: state.sourceId,
        methodologyVersion: state.methodologyVersion,
        cycleId: cycle.cycleId,
        occurredAt: cycle.completedAt,
        deviationBand: cycle.deviationBand,
        before,
        after: snapshot(state),
      },
    ],
  }
}

export function appendDiscrepancyAmendment({
  state,
  eventId: amendmentEventId,
  targetEvent,
  type,
  occurredAt,
  reason,
  correctedDeviationBand,
}: {
  state: PersistedDiscrepancyState
  eventId: string
  targetEvent: DiscrepancyMeasurementEvent
  type: 'corrected' | 'retracted'
  occurredAt: string
  reason: string
  correctedDeviationBand?: DeviationBand
}): DiscrepancyAmendmentEvent {
  state = persistedDiscrepancyStateSchema.parse(state)
  assertIdentifier('eventId', amendmentEventId)
  assertIdentifier('targetEvent.eventId', targetEvent.eventId)
  assertNonEmpty('reason', reason)
  parseUtc('occurredAt', occurredAt)
  if (
    targetEvent.discrepancyId !== state.discrepancyId ||
    targetEvent.sourceId !== state.sourceId ||
    targetEvent.methodologyVersion !== state.methodologyVersion
  ) {
    throw new Error('amendment target must belong to the same discrepancy, source, and methodology')
  }
  if (Date.parse(occurredAt) < parseUtc('targetEvent.occurredAt', targetEvent.occurredAt)) {
    throw new Error('amendment cannot precede its target event')
  }
  if (type === 'corrected') {
    if (correctedDeviationBand === undefined) {
      throw new Error('a correction requires correctedDeviationBand')
    }
    assertDeviationBand('correctedDeviationBand', correctedDeviationBand)
  } else if (correctedDeviationBand !== undefined) {
    throw new Error('a retraction cannot include correctedDeviationBand')
  }

  return {
    eventId: amendmentEventId,
    type,
    discrepancyId: state.discrepancyId,
    sourceId: state.sourceId,
    methodologyVersion: state.methodologyVersion,
    targetEventId: targetEvent.eventId,
    occurredAt,
    reason: reason.trim(),
    ...(correctedDeviationBand === undefined ? {} : { correctedDeviationBand }),
    requiresReplay: true,
  }
}

/** Applies fail-closed publication actions independently from measurement severity. */
export function transitionDiscrepancyPublication({
  state,
  action,
  replyWindowHours = DEFAULT_REPLY_WINDOW_HOURS,
}: {
  state: PersistedDiscrepancyState
  action: PublicationAction
  replyWindowHours?: number
}): { state: PersistedDiscrepancyState; event: DiscrepancyPublicationEvent } {
  state = persistedDiscrepancyStateSchema.parse(state)
  assertIdentifier('action.eventId', action.eventId)
  const actionAt = parseUtc('action.occurredAt', action.occurredAt)
  if (!Number.isFinite(replyWindowHours) || replyWindowHours <= 0) {
    throw new Error('replyWindowHours must be a finite number greater than zero')
  }
  if (actionAt < parseUtc('state.publicationUpdatedAt', state.publicationUpdatedAt)) {
    throw new Error('publication action cannot precede the current publication state')
  }
  const before = {
    publicationState: state.publicationState,
    replyReviewState: state.replyReviewState,
  }
  let publicationState = state.publicationState
  let replyReviewState = state.replyReviewState
  let reviewerId: string | undefined

  switch (action.type) {
    case 'begin_reply':
      assertIdentifier('action.notificationId', action.notificationId)
      if (!state.namedParty || state.lifecycleState !== 'open' || state.severity === 'info') {
        throw new Error('reply review can only begin for an open named-party Warning or Critical discrepancy')
      }
      if (publicationState !== 'internal' || replyReviewState !== 'not_required') {
        throw new Error('reply review can only begin from an internal discrepancy')
      }
      publicationState = 'pending_reply'
      replyReviewState = 'awaiting_reply'
      break
    case 'record_response':
      if (publicationState !== 'pending_reply' || replyReviewState !== 'awaiting_reply') {
        throw new Error('a response can only be recorded while awaiting reply')
      }
      replyReviewState = 'response_received'
      break
    case 'review_response':
      assertIdentifier('action.reviewerId', action.reviewerId)
      if (publicationState !== 'pending_reply' || replyReviewState !== 'response_received') {
        throw new Error('a response must be received before it can be reviewed')
      }
      replyReviewState = 'response_reviewed'
      reviewerId = action.reviewerId
      break
    case 'expire_reply_window':
      if (publicationState !== 'pending_reply' || replyReviewState !== 'awaiting_reply') {
        throw new Error('only an unanswered pending reply window can expire')
      }
      if (actionAt - parseUtc('state.publicationUpdatedAt', state.publicationUpdatedAt) < replyWindowHours * 3_600_000) {
        throw new Error('reply window has not expired')
      }
      replyReviewState = 'window_expired'
      break
    case 'approve':
      assertIdentifier('action.reviewerId', action.reviewerId)
      if (state.severity === 'info') {
        throw new Error('Info discrepancies must remain internal')
      }
      if (state.namedParty && !['response_reviewed', 'window_expired'].includes(replyReviewState)) {
        throw new Error('named-party publication requires a reviewed response or expired reply window')
      }
      if (publicationState !== 'internal' && publicationState !== 'pending_reply') {
        throw new Error('only internal or pending discrepancies can be approved')
      }
      publicationState = 'approved_public'
      reviewerId = action.reviewerId
      break
    case 'withhold':
      assertIdentifier('action.reviewerId', action.reviewerId)
      if (state.severity === 'info') throw new Error('Info discrepancies must remain internal')
      if (publicationState === 'withheld') throw new Error('discrepancy is already withheld')
      publicationState = 'withheld'
      reviewerId = action.reviewerId
      break
  }

  const nextState = persistedDiscrepancyStateSchema.parse({
    ...state,
    publicationState,
    replyReviewState,
    publicationUpdatedAt: action.occurredAt,
  })
  return {
    state: nextState,
    event: {
      eventId: action.eventId,
      type: 'publication_changed',
      discrepancyId: state.discrepancyId,
      sourceId: state.sourceId,
      methodologyVersion: state.methodologyVersion,
      occurredAt: action.occurredAt,
      action: action.type,
      ...(action.type === 'begin_reply' ? { notificationId: action.notificationId } : {}),
      ...(reviewerId ? { reviewerId } : {}),
      before,
      after: { publicationState, replyReviewState },
    },
  }
}
