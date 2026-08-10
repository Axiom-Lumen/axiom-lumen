import { createHash } from 'node:crypto'
import { SUPPLY_METHODOLOGY_VERSION, supplyMethodologyConfig } from '../../config/methodology'
import {
  creditAssetSchema,
  formatNetworkAssetKey,
  networkIdentitySchema,
  sourceErrorCodeSchema,
  sourceIdentitySchema,
  type SourceError,
  type SourceIdentity,
} from '../contracts/domain'
import type { PersistenceRepositories, PersistCompletedCycleInput } from '../db/repositories'
import type { DiscoveredIngestJob } from '../db/scheduler-repository'
import { reconcileSupply, type SupplyObservation } from '../reconcile/supply'
import { fetchArchiveSupplyObservation } from '../stellar/archive-supply'
import {
  DEFAULT_HORIZON_MAX_RESPONSE_BYTES,
  DEFAULT_HORIZON_TIMEOUT_MS,
  type HorizonEndpointPolicy,
} from '../stellar/horizon'
import { fetchHorizonRawSupplyObservation } from '../stellar/supply-observation'
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

export interface SupplyJobOptions {
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
}

interface CollectedAttempt {
  attemptNumber: number
  startedAt: string
  completedAt: string
  observation?: SupplyObservation
  evidence?: unknown
  error?: ConnectorError
}

interface CollectedSource {
  source: DiscoveredIngestJob['sources'][number]
  identity: SourceIdentity
  previous?: SourceHealthProjection
  skippedByCircuit: boolean
  attempts: CollectedAttempt[]
  observation?: SupplyObservation
  evidence?: unknown
  error?: ConnectorError
}

function durableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex')}`
}

function timestamp(clock: () => Date) {
  const value = clock()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('clock must return a valid Date')
  return value.toISOString()
}

function errorCategory(code: SourceError['code']): SourceError['category'] {
  if (code === 'invalid_configuration' || code === 'invalid_asset') return 'configuration'
  if (code === 'request_failed' || code === 'request_aborted') return 'transport'
  if (code === 'non_200_response' || code === 'redirect_rejected') return 'http'
  if (code === 'network_mismatch') return 'network'
  if (code === 'stale_observation') return 'freshness'
  if (code === 'excluded_source') return 'policy'
  return 'payload'
}

function domainError(error: ConnectorError): SourceError {
  const parsedCode = sourceErrorCodeSchema.safeParse(error.code)
  const code = parsedCode.success ? parsedCode.data : 'request_failed'
  return {
    sourceId: error.sourceId,
    sourceUrl: error.sourceUrl,
    code,
    category: errorCategory(code),
    message: error.message,
    occurredAt: error.retrievedAt,
    ...(error.status === undefined ? {} : { httpStatus: error.status }),
    retryable:
      code === 'request_failed' || code === 'request_aborted' ||
      (code === 'non_200_response' &&
        ([408, 425, 429].includes(error.status ?? 0) || (error.status ?? 0) >= 500)),
  }
}

export function createSupplyJobHandler(
  repositories: PersistenceRepositories,
  clock: () => Date = () => new Date(),
  options: SupplyJobOptions = {},
): WorkerJobHandler {
  const policy = options.resiliencePolicy ?? DEFAULT_RESILIENCE_POLICY
  const endpointPolicy = options.endpointPolicy ?? {}
  const timeoutMs = options.timeoutMs ?? DEFAULT_HORIZON_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_HORIZON_MAX_RESPONSE_BYTES
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? abortableSleep

  return async ({ lease, job, signal }): Promise<PersistCompletedCycleInput> => {
    if (lease.metric !== 'circulating_supply' || job.metric !== 'circulating_supply') {
      throw new Error('supply handler received a different metric')
    }
    if (job.methodologyVersion !== SUPPLY_METHODOLOGY_VERSION || lease.methodologyVersion !== SUPPLY_METHODOLOGY_VERSION) {
      throw new Error('supply job methodology does not match the registered handler')
    }
    const asset = creditAssetSchema.parse(job.asset)
    const networkPassphrases = new Set(job.sources.map((source) => source.networkPassphrase))
    const networkIds = new Set(job.sources.map((source) => source.networkId))
    if (networkPassphrases.size !== 1 || networkIds.size !== 1) {
      throw new Error('supply sources must share one network identity')
    }
    const expectedNetwork = networkIdentitySchema.parse({
      id: job.sources[0]!.networkId,
      passphrase: job.sources[0]!.networkPassphrase,
    })
    if (formatNetworkAssetKey(expectedNetwork.id, asset) !== lease.subjectKey || job.subjectKey !== lease.subjectKey) {
      throw new Error('supply network and asset do not match the leased subject')
    }
    const configuredSources = job.sources.map((source) => sourceIdentitySchema.parse({
      id: source.id,
      url: source.url,
      sourceClass: source.sourceClass,
      adapter: source.adapter,
      network: expectedNetwork,
    }))
    const identityById = new Map(configuredSources.map((source) => [source.id, source]))
    const startedAt = timestamp(clock)
    const previousHealth = await repositories.getSourceHealthStates(job.sources.map((source) => source.id))

    const collected = await mapWithConcurrency(job.sources, policy.concurrency, async (source): Promise<CollectedSource> => {
      const identity = identityById.get(source.id)!
      const previous = previousHealth[source.id] as SourceHealthProjection | undefined
      const decisionAt = timestamp(clock)
      if (!sourceCanAttempt(previous, decisionAt)) {
        return {
          source,
          identity,
          previous,
          skippedByCircuit: true,
          attempts: [],
          error: {
            sourceId: source.id,
            sourceUrl: source.url,
            code: 'excluded_source',
            message: 'Source circuit is open until its next permitted attempt',
            retrievedAt: decisionAt,
          },
        }
      }

      const execution = await executeWithRetry({
        policy,
        signal,
        random,
        sleep,
        operation: async (attemptNumber) => {
          const attemptStartedAt = timestamp(clock)
          try {
            if (source.configurationError) {
              const completedAt = timestamp(clock)
              return { error: {
                sourceId: source.id,
                sourceUrl: source.url,
                code: 'invalid_configuration',
                message: source.configurationError,
                retrievedAt: completedAt,
                startedAt: attemptStartedAt,
                completedAt,
              } }
            }
            const observationId = durableId('observation', lease.id, source.id)
            const result = source.adapter === 'horizon'
              ? await fetchHorizonRawSupplyObservation({
                  observationId,
                  cycleId: lease.id,
                  source: identity,
                  asset,
                  expectedNetwork,
                  signal,
                  endpointPolicy,
                  timeoutMs,
                  maxResponseBytes,
                  clock,
                })
              : source.adapter === 'archive'
                ? await fetchArchiveSupplyObservation({
                    observationId,
                    cycleId: lease.id,
                    source: identity,
                    asset,
                    expectedNetwork,
                    trustedCheckpoint: source.trustedCheckpoint,
                    signal,
                    endpointPolicy,
                    timeoutMs,
                    maxResponseBytes,
                    clock,
                  })
                : {
                    error: {
                      sourceId: source.id,
                      sourceUrl: source.url,
                      code: 'invalid_configuration' as const,
                      message: 'Supply supports Horizon and archive adapters only',
                      retrievedAt: timestamp(clock),
                    },
                  }
            const completedAt = result.error?.retrievedAt ?? timestamp(clock)
            return result.error
              ? { error: { ...result.error, startedAt: attemptStartedAt, completedAt } }
              : { value: {
                  attemptNumber,
                  startedAt: attemptStartedAt,
                  completedAt,
                  observation: result.observation,
                  evidence: result.evidence,
                } }
          } catch (error) {
            if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
            const completedAt = timestamp(clock)
            return { error: {
              sourceId: source.id,
              sourceUrl: source.url,
              code: 'invalid_configuration',
              message: 'Source result failed supply contract validation',
              retrievedAt: completedAt,
              startedAt: attemptStartedAt,
              completedAt,
            } }
          }
        },
      })

      const attempts: CollectedAttempt[] = execution.attempts.map((attempt, index) => attempt.value
        ? attempt.value
        : {
            attemptNumber: index + 1,
            startedAt: (attempt.error as ConnectorError & { startedAt: string }).startedAt,
            completedAt: (attempt.error as ConnectorError & { completedAt: string }).completedAt,
            error: attempt.error,
          })
      const final = attempts.at(-1)!
      return {
        source,
        identity,
        previous,
        skippedByCircuit: false,
        attempts,
        ...(final.observation
          ? { observation: final.observation, evidence: final.evidence }
          : { error: final.error }),
      }
    })

    if (signal.aborted) throw new DOMException('Worker operation was cancelled', 'AbortError')
    const completedAt = timestamp(clock)
    const staleSourceIds = new Set(collected.flatMap((result) => {
      if (!result.observation) return []
      const ageSeconds = (Date.parse(completedAt) - Date.parse(result.observation.provenance.sourceTimestamp!)) / 1_000
      return ageSeconds > supplyMethodologyConfig.maximumObservationAgeSeconds ? [result.source.id] : []
    }))
    const connectorErrors = collected.flatMap((result) => result.error ? [result.error] : [])
    const staleErrors: ConnectorError[] = collected.flatMap((result) => staleSourceIds.has(result.source.id) ? [{
      sourceId: result.source.id,
      sourceUrl: result.source.url,
      code: 'stale_observation',
      message: 'Supply observation is older than the maximum accepted ledger age',
      retrievedAt: completedAt,
    }] : [])
    const sourceErrors = [...connectorErrors, ...staleErrors]
    const observations = collected.flatMap((result) => result.observation ? [result.observation] : [])
    const priorDiscrepancyStates = await repositories.getDiscrepancyStates('circulating_supply', lease.subjectKey)
    const reconciled = reconcileSupply({
      cycleId: lease.id,
      snapshotId: durableId('snapshot', lease.id),
      asset,
      configuredSources,
      observations,
      sourceErrors: sourceErrors.map(domainError),
      priorDiscrepancyStates,
      asOf: new Date(completedAt),
    })

    const healthStates = collected.map((result) => {
      if (result.skippedByCircuit && result.previous) return { ...result.previous, lastObservedAt: completedAt }
      const error = staleSourceIds.has(result.source.id)
        ? staleErrors.find((candidate) => candidate.sourceId === result.source.id)
        : result.error
      return transitionSourceHealth({
        sourceId: result.source.id,
        previous: result.previous,
        error,
        observedAt: completedAt,
        policy,
      })
    })
    const attempts = collected.flatMap((result) => result.attempts.map((attempt) => ({
      id: durableId('attempt', lease.id, result.source.id, String(attempt.attemptNumber)),
      sourceId: result.source.id,
      attemptNumber: attempt.attemptNumber,
      outcome: attempt.observation ? ('success' as const) : ('failure' as const),
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
      httpStatus: attempt.observation ? 200 : attempt.error?.status ?? null,
      error: attempt.error ? { ...attempt.error } : null,
    })))

    return {
      cycle: {
        id: lease.id,
        metric: 'circulating_supply',
        subjectKey: lease.subjectKey,
        methodologyVersion: lease.methodologyVersion,
        idempotencyKey: lease.idempotencyKey,
        scheduledAt: lease.scheduledAt,
        startedAt,
        completedAt,
      },
      attempts,
      readings: collected.flatMap((result) => {
        if (!result.observation) return []
        const finalAttempt = result.attempts.at(-1)!
        return [{
          id: durableId('reading', lease.id, result.source.id),
          observationId: result.observation.observationId,
          attemptId: durableId('attempt', lease.id, result.source.id, String(finalAttempt.attemptNumber)),
          sourceId: result.source.id,
          sourceIdentity: result.identity,
          normalizedValue: { kind: 'amount', value: result.observation.amount },
          rawPayload: { observation: result.observation, evidence: result.evidence },
          sourceTimestamp: result.observation.provenance.sourceTimestamp,
          retrievedAt: result.observation.provenance.retrievedAt,
        }]
      }),
      sourceHealth: collected.map((result) => {
        const health = healthStates.find((candidate) => candidate.sourceId === result.source.id)!
        const first = result.attempts[0]
        const last = result.attempts.at(-1)
        return {
          id: durableId('health', lease.id, result.source.id),
          sourceId: result.source.id,
          state: health.state,
          latencyMs: !first || !last ? null : Math.max(0, Date.parse(last.completedAt) - Date.parse(first.startedAt)),
          details: {
            attemptCount: result.attempts.length,
            circuitState: health.circuitState,
            skippedByCircuit: result.skippedByCircuit,
            derivationFamily: result.observation?.derivation.family ?? null,
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
