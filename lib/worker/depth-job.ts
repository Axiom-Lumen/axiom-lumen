import { createHash } from 'node:crypto'
import { DEPTH_RECONCILIATION_METHODOLOGY_VERSION, depthReconciliationMethodologyConfig } from '../../config/methodology'
import {
  formatNetworkPairKey,
  networkIdentitySchema,
  sourceErrorCodeSchema,
  sourceIdentitySchema,
  type SourceError,
  type SourceIdentity,
} from '../contracts/domain'
import type { PersistenceRepositories, PersistCompletedCycleInput } from '../db/repositories'
import type { DiscoveredIngestJob } from '../db/scheduler-repository'
import { reconcileDepth, toDepthBookObservation, type DepthBookObservation } from '../reconcile/depth'
import {
  DEFAULT_HORIZON_MAX_RESPONSE_BYTES,
  DEFAULT_HORIZON_TIMEOUT_MS,
  type HorizonEndpointPolicy,
} from '../stellar/horizon'
import { fetchHorizonOrderBookDepth, type HorizonDepthObservation } from '../stellar/horizon-depth'
import {
  abortableSleep,
  executeWithRetry,
  mapWithConcurrency,
  sourceCanAttempt,
  transitionSourceHealth,
  type SourceHealthProjection,
  type SourceResiliencePolicy,
} from './resilience'
import type { WorkerJobHandler } from './scheduler'

const DEFAULT_POLICY: SourceResiliencePolicy = {
  maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 5_000, jitterRatio: 0.2, concurrency: 4,
  circuitFailureThreshold: 3, circuitCooldownMs: 60_000,
}

export interface DepthJobOptions {
  endpointPolicy?: HorizonEndpointPolicy
  resiliencePolicy?: SourceResiliencePolicy
  timeoutMs?: number
  maxResponseBytes?: number
  random?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

interface ConnectorError {
  sourceId: string
  sourceUrl: string
  code: string
  message: string
  retrievedAt: string
  status?: number
  retryAfterMs?: number
  startedAt?: string
  completedAt?: string
}

interface Attempt { attemptNumber: number; startedAt: string; completedAt: string; connectorObservation?: HorizonDepthObservation; observation?: DepthBookObservation; error?: ConnectorError }
interface Collected { source: DiscoveredIngestJob['sources'][number]; identity: SourceIdentity; previous?: SourceHealthProjection; skippedByCircuit: boolean; attempts: Attempt[]; connectorObservation?: HorizonDepthObservation; observation?: DepthBookObservation; error?: ConnectorError }

function durableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex')}`
}
function timestamp(clock: () => Date) {
  const value = clock()
  if (!Number.isFinite(value.getTime())) throw new Error('clock must return a valid Date')
  return value.toISOString()
}
function errorCategory(code: SourceError['code']): SourceError['category'] {
  if (code === 'invalid_configuration' || code === 'invalid_pair') return 'configuration'
  if (code === 'request_failed' || code === 'request_aborted') return 'transport'
  if (code === 'non_200_response' || code === 'redirect_rejected') return 'http'
  if (code === 'network_mismatch') return 'network'
  if (code === 'stale_book') return 'freshness'
  if (code === 'excluded_source') return 'policy'
  return 'payload'
}
function domainError(error: ConnectorError): SourceError {
  const parsed = sourceErrorCodeSchema.safeParse(error.code)
  const code = parsed.success ? parsed.data : 'request_failed'
  return {
    sourceId: error.sourceId, sourceUrl: error.sourceUrl, code, category: errorCategory(code),
    message: error.message, occurredAt: error.retrievedAt,
    ...(error.status === undefined ? {} : { httpStatus: error.status }),
    retryable: code === 'request_failed' || code === 'request_aborted' || (code === 'non_200_response' && ([408, 425, 429].includes(error.status ?? 0) || (error.status ?? 0) >= 500)),
  }
}

export function createDepthJobHandler(
  repositories: PersistenceRepositories,
  clock: () => Date = () => new Date(),
  options: DepthJobOptions = {},
): WorkerJobHandler {
  const policy = options.resiliencePolicy ?? DEFAULT_POLICY
  return async ({ lease, job, signal }): Promise<PersistCompletedCycleInput> => {
    if (lease.metric !== 'order_book_depth' || job.metric !== 'order_book_depth') throw new Error('depth handler received a different metric')
    if (lease.methodologyVersion !== DEPTH_RECONCILIATION_METHODOLOGY_VERSION || job.methodologyVersion !== DEPTH_RECONCILIATION_METHODOLOGY_VERSION) throw new Error('depth methodology does not match the handler')
    const networkIds = new Set(job.sources.map((source) => source.networkId))
    const passphrases = new Set(job.sources.map((source) => source.networkPassphrase))
    if (networkIds.size !== 1 || passphrases.size !== 1) throw new Error('depth sources must share one network')
    const expectedNetwork = networkIdentitySchema.parse({ id: job.sources[0]!.networkId, passphrase: job.sources[0]!.networkPassphrase })
    if (formatNetworkPairKey(expectedNetwork.id, job.pair) !== lease.subjectKey || job.subjectKey !== lease.subjectKey) throw new Error('depth pair does not match leased subject')
    const identities = job.sources.map((source) => sourceIdentitySchema.parse({ id: source.id, url: source.url, sourceClass: source.sourceClass, adapter: source.adapter, network: expectedNetwork }))
    const identityById = new Map(identities.map((identity) => [identity.id, identity]))
    const startedAt = timestamp(clock)
    const previousHealth = await repositories.getSourceHealthStates(job.sources.map((source) => source.id))
    const collected = await mapWithConcurrency(job.sources, policy.concurrency, async (source): Promise<Collected> => {
      const identity = identityById.get(source.id)!
      const previous = previousHealth[source.id] as SourceHealthProjection | undefined
      const decisionAt = timestamp(clock)
      if (!sourceCanAttempt(previous, decisionAt)) return { source, identity, previous, skippedByCircuit: true, attempts: [], error: { sourceId: source.id, sourceUrl: source.url, code: 'excluded_source', message: 'Source circuit is open until its next permitted attempt', retrievedAt: decisionAt } }
      const execution = await executeWithRetry<Attempt, ConnectorError>({
        policy, signal, random: options.random ?? Math.random, sleep: options.sleep ?? abortableSleep,
        operation: async (attemptNumber) => {
          const attemptStartedAt = timestamp(clock)
          if (source.configurationError || source.adapter !== 'sdex') {
            const completedAt = timestamp(clock)
            return { error: { sourceId: source.id, sourceUrl: source.url, code: 'invalid_configuration', message: source.configurationError ?? 'Depth supports SDEX adapters only', retrievedAt: completedAt, startedAt: attemptStartedAt, completedAt } }
          }
          try {
            const result = await fetchHorizonOrderBookDepth({ source: identity, pair: job.pair, expectedNetwork, signal, endpointPolicy: options.endpointPolicy ?? {}, timeoutMs: options.timeoutMs ?? DEFAULT_HORIZON_TIMEOUT_MS, maxResponseBytes: options.maxResponseBytes ?? DEFAULT_HORIZON_MAX_RESPONSE_BYTES, clock })
            const completedAt = result.error?.retrievedAt ?? timestamp(clock)
            if (result.error) return { error: { ...result.error, sourceId: source.id, sourceUrl: source.url, startedAt: attemptStartedAt, completedAt } }
            const connectorObservation = result.observation
            const observation = toDepthBookObservation({ observationId: durableId('observation', lease.id, source.id), cycleId: lease.id, observation: connectorObservation }) ?? undefined
            const stateError = connectorObservation.bookStatus === 'empty' ? { code: 'empty_book', message: 'SDEX order book is empty' } : connectorObservation.bookStatus === 'one_sided' ? { code: 'one_sided_book', message: 'SDEX order book has only one side' } : null
            return stateError
              ? { value: { attemptNumber, startedAt: attemptStartedAt, completedAt, connectorObservation, error: { sourceId: source.id, sourceUrl: source.url, ...stateError, retrievedAt: completedAt } } }
              : { value: { attemptNumber, startedAt: attemptStartedAt, completedAt, connectorObservation, observation } }
          } catch (error) {
            if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
            const completedAt = timestamp(clock)
            return { error: { sourceId: source.id, sourceUrl: source.url, code: 'malformed_payload', message: 'Source result failed depth contract validation', retrievedAt: completedAt, startedAt: attemptStartedAt, completedAt } }
          }
        },
      })
      const attempts: Attempt[] = execution.attempts.map((attempt, index) => attempt.value ?? { attemptNumber: index + 1, startedAt: (attempt.error as ConnectorError).startedAt!, completedAt: (attempt.error as ConnectorError).completedAt!, error: attempt.error })
      const final = attempts.at(-1)!
      return { source, identity, previous, skippedByCircuit: false, attempts, connectorObservation: final.connectorObservation, observation: final.observation, error: final.error }
    })
    if (signal.aborted) throw new DOMException('Worker operation was cancelled', 'AbortError')
    const completedAt = timestamp(clock)
    const sourceErrors = collected.flatMap((result) => result.error ? [domainError(result.error)] : [])
    const prior = await repositories.getDiscrepancyStates('order_book_depth', lease.subjectKey)
    const reconciled = reconcileDepth({ cycleId: lease.id, snapshotId: durableId('snapshot', lease.id), pair: job.pair, configuredSources: identities, observations: collected.flatMap((result) => result.observation ? [result.observation] : []), sourceErrors, priorDiscrepancyStates: prior, asOf: new Date(completedAt) })
    const healthStates = collected.map((result) => {
      if (result.skippedByCircuit && result.previous) return { ...result.previous, lastObservedAt: completedAt }
      const healthError = result.error && !['empty_book', 'one_sided_book'].includes(result.error.code) ? result.error : undefined
      return transitionSourceHealth({ sourceId: result.source.id, previous: result.previous, error: healthError, observedAt: completedAt, policy })
    })
    const attempts = collected.flatMap((result) => result.attempts.map((attempt) => ({
      id: durableId('attempt', lease.id, result.source.id, String(attempt.attemptNumber)), sourceId: result.source.id, attemptNumber: attempt.attemptNumber,
      outcome: attempt.connectorObservation ? 'success' as const : 'failure' as const, startedAt: attempt.startedAt, completedAt: attempt.completedAt,
      httpStatus: attempt.connectorObservation ? 200 : attempt.error?.status ?? null, error: attempt.connectorObservation ? null : attempt.error ? { ...attempt.error } : null,
    })))
    return {
      cycle: { id: lease.id, metric: 'order_book_depth', subjectKey: lease.subjectKey, methodologyVersion: lease.methodologyVersion, idempotencyKey: lease.idempotencyKey, scheduledAt: lease.scheduledAt, startedAt, completedAt },
      attempts,
      readings: collected.flatMap((result) => {
        if (!result.connectorObservation) return []
        const final = result.attempts.at(-1)!
        return [{
          id: durableId('reading', lease.id, result.source.id), observationId: result.observation?.observationId ?? durableId('observation', lease.id, result.source.id),
          attemptId: durableId('attempt', lease.id, result.source.id, String(final.attemptNumber)), sourceId: result.source.id, sourceIdentity: result.identity,
          normalizedValue: result.observation ? { kind: 'depth', observation: result.observation } : { kind: 'depth_state', state: result.connectorObservation.bookStatus },
          rawPayload: { observation: result.observation ?? null, connectorObservation: result.connectorObservation },
          sourceTimestamp: result.connectorObservation.sourceTimestamp, retrievedAt: result.connectorObservation.retrievedAt,
        }]
      }),
      sourceHealth: collected.map((result) => {
        const health = healthStates.find((candidate) => candidate.sourceId === result.source.id)!
        const first = result.attempts[0]; const last = result.attempts.at(-1)
        return { id: durableId('health', lease.id, result.source.id), sourceId: result.source.id, state: health.state, latencyMs: !first || !last ? null : Math.max(0, Date.parse(last.completedAt) - Date.parse(first.startedAt)), details: { attemptCount: result.attempts.length, circuitState: health.circuitState, skippedByCircuit: result.skippedByCircuit, bookStatus: result.connectorObservation?.bookStatus ?? null }, observedAt: completedAt }
      }),
      sourceHealthStates: healthStates, snapshot: reconciled.snapshot, discrepancyStates: reconciled.discrepancyStates, events: reconciled.events,
    }
  }
}
