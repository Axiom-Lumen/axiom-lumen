import { createHash } from 'node:crypto'
import { z } from 'zod'
import { methodologyConfig } from '../../config/methodology'
import {
  identifierSchema,
  persistedDiscrepancyStateSchema,
  utcTimestampSchema,
  type PersistedDiscrepancyState,
} from '../contracts/domain'
import { computeEvidenceSha256 } from '../evidence/json'

export const ANCHOR_NOTICE_PAYLOAD_VERSION = 'anchor-discrepancy-notice-v0.1' as const

export const anchorNoticeChannelSchema = z.enum(['email', 'webhook'])
export type AnchorNoticeChannel = z.infer<typeof anchorNoticeChannelSchema>

export const eligibleAnchorContactSchema = z.object({
  id: identifierSchema,
  kind: anchorNoticeChannelSchema,
  verifiedAt: utcTimestampSchema,
}).strict()
export type EligibleAnchorContact = z.infer<typeof eligibleAnchorContactSchema>

export interface AnchorCasePlan {
  caseRecord: {
    id: string
    anchorId: string
    discrepancyId: string
    status: 'draft'
    openedAt: string
    replyDueAt: null
  }
  caseEvent: {
    id: string
    caseId: string
    eventType: 'opened'
    actorType: 'system'
    actorId: null
    payload: Record<string, unknown>
    occurredAt: string
  }
  notifications: Array<{
    id: string
    caseId: string
    contactEndpointId: string
    channel: AnchorNoticeChannel
    idempotencyKey: string
    payload: Record<string, unknown>
    payloadSha256: string
  }>
}

function durableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex')}`
}

function assertEligibleDiscrepancy(state: PersistedDiscrepancyState) {
  if (!state.namedParty || state.lifecycleState !== 'open' || state.severity === 'info') {
    throw new Error('anchor cases require an open named-party Warning or Critical discrepancy')
  }
  if (state.publicationState !== 'internal' || state.replyReviewState !== 'not_required') {
    throw new Error('anchor cases can only open before reply review begins')
  }
}

/**
 * Produces a deterministic case and one initial notice per verified contact.
 * The reply deadline remains null until a delivery succeeds; queueing a notice
 * must never start the right-of-reply clock or make a discrepancy publishable.
 */
export function planAnchorCase(input: {
  anchorId: string
  discrepancyState: PersistedDiscrepancyState | unknown
  triggeringEventId: string
  contacts: readonly EligibleAnchorContact[]
  openedAt: string
  replyWindowHours?: number
}): AnchorCasePlan {
  const anchorId = identifierSchema.parse(input.anchorId)
  const state = persistedDiscrepancyStateSchema.parse(input.discrepancyState)
  const triggeringEventId = identifierSchema.parse(input.triggeringEventId)
  const openedAt = utcTimestampSchema.parse(input.openedAt)
  const replyWindowHours = input.replyWindowHours ?? methodologyConfig.publication.replyWindowHours
  if (!Number.isSafeInteger(replyWindowHours) || replyWindowHours <= 0) {
    throw new Error('replyWindowHours must be a positive safe integer')
  }
  assertEligibleDiscrepancy(state)
  const contacts = input.contacts.map((contact) => eligibleAnchorContactSchema.parse(contact))
  if (contacts.length === 0) throw new Error('an anchor case requires at least one verified email or webhook contact')
  if (new Set(contacts.map((contact) => contact.id)).size !== contacts.length) {
    throw new Error('anchor case contacts must be unique')
  }
  if (contacts.some((contact) => Date.parse(contact.verifiedAt) > Date.parse(openedAt))) {
    throw new Error('contact verification cannot occur after the case opens')
  }

  const caseId = durableId('anchor_case', anchorId, state.discrepancyId)
  const commonPayload = {
    version: ANCHOR_NOTICE_PAYLOAD_VERSION,
    caseId,
    anchorId,
    discrepancyId: state.discrepancyId,
    triggeringEventId,
    severity: state.severity,
    methodologyVersion: state.methodologyVersion,
    firstObservedAt: state.firstObservedAt,
    lastObservedAt: state.lastObservedAt,
    responseWindowHours: replyWindowHours,
  }
  return {
    caseRecord: {
      id: caseId,
      anchorId,
      discrepancyId: state.discrepancyId,
      status: 'draft',
      openedAt,
      replyDueAt: null,
    },
    caseEvent: {
      id: durableId('anchor_case_event', caseId, 'opened'),
      caseId,
      eventType: 'opened',
      actorType: 'system',
      actorId: null,
      payload: { triggeringEventId, methodologyVersion: state.methodologyVersion },
      occurredAt: openedAt,
    },
    notifications: contacts
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((contact) => {
        const payload = { ...commonPayload, channel: contact.kind }
        return {
          id: durableId('notification', caseId, contact.id, 'initial'),
          caseId,
          contactEndpointId: contact.id,
          channel: contact.kind,
          idempotencyKey: `${caseId}:${contact.id}:initial`,
          payload,
          payloadSha256: computeEvidenceSha256(payload),
        }
      }),
  }
}

export function replyDueAt(sentAt: string, replyWindowHours = methodologyConfig.publication.replyWindowHours) {
  const sent = utcTimestampSchema.parse(sentAt)
  if (!Number.isSafeInteger(replyWindowHours) || replyWindowHours <= 0) {
    throw new Error('replyWindowHours must be a positive safe integer')
  }
  return new Date(Date.parse(sent) + replyWindowHours * 3_600_000).toISOString()
}
