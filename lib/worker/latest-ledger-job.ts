import { createHash } from 'node:crypto'
import { networkIdSchema } from '../contracts/domain'
import type { PersistenceRepositories, PersistCompletedCycleInput } from '../db/repositories'
import type { DiscoveredIngestJob } from '../db/scheduler-repository'
import {
  DEFAULT_HORIZON_HALF_LIFE_SECONDS,
  LATEST_LEDGER_METHODOLOGY_VERSION,
  reconcileLatestLedgerDomain,
} from '../reconcile/latest-ledger'
import type { LatestLedgerObservation, LatestLedgerSourceError } from '../reconcile/latest-ledger'
import {
  DEFAULT_HORIZON_MAX_RESPONSE_BYTES,
  DEFAULT_HORIZON_TIMEOUT_MS,
  fetchLatestLedgersFromHorizonSources,
  type HorizonEndpointPolicy,
} from '../stellar/horizon'
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

const DEFAULT_RESILIENCE_POLICY: SourceResiliencePolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  jitterRatio: 0.2,
  concurrency: 4,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 60_000,
}

export interface LatestLedgerJobOptions {
  endpointPolicy?: HorizonEndpointPolicy
  resiliencePolicy?: SourceResiliencePolicy
  timeoutMs?: number
  maxResponseBytes?: number
  random?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

interface TimedSourceError extends LatestLedgerSourceError {
  startedAt: string
  completedAt: string
}

interface SuccessfulAttempt {
  attemptNumber: number
  startedAt: string
  completedAt: string
  observation: LatestLedgerObservation
}

interface FailedAttempt {
  attemptNumber: number
  startedAt: string
  completedAt: string
  error: LatestLedgerSourceError
}

type CollectedAttempt = SuccessfulAttempt | FailedAttempt

interface CollectedSource {
  source: DiscoveredIngestJob['sources'][number]
  previous?: SourceHealthProjection
  skippedByCircuit: boolean
  attempts: CollectedAttempt[]
  observation?: LatestLedgerObservation
  error?: LatestLedgerSourceError
}

function durableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex')}`
}

function validTimestamp(clock: () => Date) {
  const value = clock()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('clock must return a valid Date')
  return value.toISOString()
}

function withoutTiming(error: TimedSourceError): LatestLedgerSourceError {
  const { startedAt: _startedAt, completedAt: _completedAt, ...sourceError } = error
  return sourceError
}

export function createLatestLedgerJobHandler(
  repositories: PersistenceRepositories,
  clock: () => Date = () => new Date(),
  options: LatestLedgerJobOptions = {},
): WorkerJobHandler {
  const resiliencePolicy = options.resiliencePolicy ?? DEFAULT_RESILIENCE_POLICY
  const endpointPolicy = options.endpointPolicy ?? {}
  const timeoutMs = options.timeoutMs ?? DEFAULT_HORIZON_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_HORIZON_MAX_RESPONSE_BYTES
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? abortableSleep

  return async ({ lease, job, signal }): Promise<PersistCompletedCycleInput> => {
    if (lease.metric !== 'latest_ledger' || job.metric !== 'latest_ledger') {
      throw new Error('latest-ledger handler received a different metric')
    }
    if (job.methodologyVersion !== LATEST_LEDGER_METHODOLOGY_VERSION) {
      throw new Error('latest-ledger job methodology does not match the registered handler')
    }
    const networkPassphrases = new Set(job.sources.map((source) => source.networkPassphrase))
    if (networkPassphrases.size !== 1) throw new Error('latest-ledger sources must share one network passphrase')
    const networkPassphrase = job.sources[0]?.networkPassphrase
    if (!networkPassphrase) throw new Error('latest-ledger job requires at least one source')

    const startedAt = validTimestamp(clock)
    const previousHealth = await repositories.getSourceHealthStates(job.sources.map((source) => source.id))
    const collected = await mapWithConcurrency(job.sources, resiliencePolicy.concurrency, async (source): Promise<CollectedSource> => {
      const decisionAt = validTimestamp(clock)
      const previous = previousHealth[source.id] as SourceHealthProjection | undefined
      if (!sourceCanAttempt(previous, decisionAt)) {
        const error: LatestLedgerSourceError = {
          sourceId: source.id,
          sourceUrl: source.url,
          code: 'excluded_source',
          message: 'Source circuit is open until its next permitted attempt',
          retrievedAt: decisionAt,
        }
        return {
          source,
          previous,
          skippedByCircuit: true,
          attempts: [],
          error,
        }
      }

      const execution = await executeWithRetry({
        policy: resiliencePolicy,
        signal,
        random,
        sleep,
        operation: async (attemptNumber) => {
          const attemptStartedAt = validTimestamp(clock)
          try {
            const result = await fetchLatestLedgersFromHorizonSources({
              sources: [{ id: source.id, url: source.url }],
              expectedNetworkPassphrase: networkPassphrase,
              clock,
              signal,
              endpointPolicy,
              timeoutMs,
              maxResponseBytes,
            })
            const observation = result.observations[0]
            if (observation) {
              return { value: { attemptNumber, startedAt: attemptStartedAt, completedAt: result.retrieved_at, observation } }
            }
            const error = result.source_errors[0]
            if (!error) throw new Error(`source ${source.id} returned neither an observation nor an error`)
            return { error: { ...error, startedAt: attemptStartedAt, completedAt: result.retrieved_at } }
          } catch (error) {
            if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
            const completedAt = validTimestamp(clock)
            return {
              error: {
                sourceId: source.id,
                sourceUrl: source.url,
                code: 'invalid_configuration',
                message: 'Source configuration was rejected before retrieval',
                retrievedAt: completedAt,
                startedAt: attemptStartedAt,
                completedAt,
              },
            }
          }
        },
      })

      const attempts: CollectedAttempt[] = execution.attempts.map((attempt, index) => {
        if (attempt.value) return attempt.value
        const error = attempt.error!
        return {
          attemptNumber: index + 1,
          startedAt: error.startedAt,
          completedAt: error.completedAt,
          error: withoutTiming(error),
        }
      })
      const finalAttempt = attempts.at(-1)!
      return {
        source,
        previous,
        skippedByCircuit: false,
        attempts,
        ...('observation' in finalAttempt
          ? { observation: finalAttempt.observation }
          : { error: finalAttempt.error }),
      }
    })

    if (signal.aborted) throw new DOMException('Worker operation was cancelled', 'AbortError')
    const completedAt = validTimestamp(clock)
    const observations = collected.flatMap((result) => result.observation ? [result.observation] : [])
    const sourceErrors = collected.flatMap((result) => result.error ? [result.error] : [])
    const priorDiscrepancyStates = await repositories.getDiscrepancyStates('latest_ledger', lease.subjectKey)
    const network = { id: networkIdSchema.parse(lease.subjectKey), passphrase: networkPassphrase }
    const sourcesById = new Map(job.sources.map((source) => [source.id, source]))
    const profiledObservations = observations.map((observation) => {
      const source = sourcesById.get(observation.sourceId)
      if (!source) throw new Error(`Horizon returned an unknown source ${observation.sourceId}`)
      return {
        ...observation,
        sourceClass: source.sourceClass,
        ...(source.upstreamId ? { upstreamId: source.upstreamId } : {}),
      }
    })
    const reconciled = reconcileLatestLedgerDomain({
      cycleId: lease.id,
      snapshotId: durableId('snapshot', lease.id),
      observations: profiledObservations,
      sourceErrors,
      sourcesConfigured: job.sources.length,
      sourcesExcluded: sourceErrors.filter((error) => error.code === 'network_mismatch').length,
      asOf: new Date(completedAt),
      network,
      priorDiscrepancyStates,
    })

    const healthStates = collected.map((result) => {
      if (result.skippedByCircuit && result.previous) {
        return { ...result.previous, lastObservedAt: completedAt }
      }
      const observationAgeMs = result.observation
        ? Date.parse(completedAt) - Date.parse(result.observation.closedAt)
        : 0
      const healthError = result.observation && observationAgeMs > DEFAULT_HORIZON_HALF_LIFE_SECONDS * 1_000
        ? {
            sourceId: result.source.id,
            sourceUrl: result.source.url,
            code: 'stale_observation',
            message: 'Latest ledger observation is older than the configured freshness half-life',
            retrievedAt: completedAt,
          }
        : result.error
      return transitionSourceHealth({
        sourceId: result.source.id,
        previous: result.previous,
        error: healthError,
        observedAt: completedAt,
        policy: resiliencePolicy,
      })
    })
    const healthBySource = new Map(healthStates.map((health) => [health.sourceId, health]))
    const contributionBySource = new Map(reconciled.snapshot.contributions.map((item) => [item.sourceId, item]))
    const attempts = collected.flatMap((result) => result.attempts.map((attempt) => ({
      id: durableId('attempt', lease.id, result.source.id, String(attempt.attemptNumber)),
      sourceId: result.source.id,
      attemptNumber: attempt.attemptNumber,
      outcome: 'observation' in attempt ? ('success' as const) : ('failure' as const),
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
      httpStatus: 'error' in attempt ? attempt.error.status ?? null : 200,
      error: 'error' in attempt ? { ...attempt.error } : null,
    })))
    const successfulAttemptBySource = new Map(
      collected.flatMap((result) => result.observation
        ? [[result.source.id, durableId('attempt', lease.id, result.source.id, String(result.attempts.at(-1)!.attemptNumber))] as const]
        : []),
    )

    return {
      cycle: {
        id: lease.id,
        metric: 'latest_ledger',
        subjectKey: lease.subjectKey,
        methodologyVersion: lease.methodologyVersion,
        idempotencyKey: lease.idempotencyKey,
        scheduledAt: lease.scheduledAt,
        startedAt,
        completedAt,
      },
      attempts,
      readings: profiledObservations.map((observation) => {
        const contribution = contributionBySource.get(observation.sourceId)
        const attemptId = successfulAttemptBySource.get(observation.sourceId)
        const source = sourcesById.get(observation.sourceId)
        if (!contribution || !attemptId || !source) {
          throw new Error(`observation ${observation.sourceId} has no durable context`)
        }
        return {
          id: durableId('reading', lease.id, observation.sourceId),
          observationId: contribution.observationId,
          attemptId,
          sourceId: observation.sourceId,
          sourceIdentity: {
            id: source.id,
            sourceClass: source.sourceClass,
            adapter: source.adapter,
            url: source.url,
            network,
          },
          normalizedValue: { kind: 'ledger', value: observation.ledgerSequence },
          rawPayload: observation.rawPayload ?? {
            sequence: observation.ledgerSequence,
            closed_at: observation.closedAt,
          },
          sourceTimestamp: observation.closedAt,
          retrievedAt: observation.retrievedAt,
        }
      }),
      sourceHealth: collected.map((result) => {
        const health = healthBySource.get(result.source.id)!
        const firstAttempt = result.attempts[0]
        const lastAttempt = result.attempts.at(-1)
        return {
          id: durableId('health', lease.id, result.source.id),
          sourceId: result.source.id,
          state: health.state,
          latencyMs: result.skippedByCircuit || !firstAttempt || !lastAttempt
            ? null
            : Math.max(0, Date.parse(lastAttempt.completedAt) - Date.parse(firstAttempt.startedAt)),
          details: {
            attemptCount: result.attempts.length,
            circuitState: health.circuitState,
            skippedByCircuit: result.skippedByCircuit,
            ...(health.lastErrorCode ? { lastErrorCode: health.lastErrorCode } : {}),
          },
          observedAt: completedAt,
        }
      }),
      sourceHealthStates: healthStates,
      snapshot: reconciled.snapshot,
      discrepancyStates: reconciled.discrepancyStates,
      events: reconciled.events,
    }
  }
}
