import { createHash } from 'node:crypto'
import { TRUSTLINE_METHODOLOGY_VERSION, trustlineMethodologyConfig } from '../../config/methodology'
import { creditAssetSchema, formatNetworkAssetKey, networkIdentitySchema, sourceErrorCodeSchema, sourceIdentitySchema, type SourceError, type SourceIdentity } from '../contracts/domain'
import type { PersistenceRepositories, PersistCompletedCycleInput } from '../db/repositories'
import type { DiscoveredIngestJob } from '../db/scheduler-repository'
import { reconcileTrustlines, type TrustlineObservation } from '../reconcile/trustlines'
import { DEFAULT_HORIZON_MAX_RESPONSE_BYTES, DEFAULT_HORIZON_TIMEOUT_MS, type HorizonEndpointPolicy } from '../stellar/horizon'
import { fetchHorizonTrustlineObservation } from '../stellar/horizon-trustlines'
import { abortableSleep, executeWithRetry, mapWithConcurrency, sourceCanAttempt, transitionSourceHealth, type SourceHealthProjection, type SourceResiliencePolicy } from './resilience'
import type { WorkerJobHandler } from './scheduler'

const DEFAULT_POLICY: SourceResiliencePolicy = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 5_000, jitterRatio: 0.2, concurrency: 4, circuitFailureThreshold: 3, circuitCooldownMs: 60_000 }
export interface TrustlineJobOptions { endpointPolicy?: HorizonEndpointPolicy; resiliencePolicy?: SourceResiliencePolicy; timeoutMs?: number; maxResponseBytes?: number; random?: () => number; sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void> }
interface ConnectorError { sourceId: string; sourceUrl: string; code: string; message: string; retrievedAt: string; status?: number; retryAfterMs?: number; startedAt?: string; completedAt?: string }
interface Attempt { attemptNumber: number; startedAt: string; completedAt: string; observation?: TrustlineObservation; evidence?: unknown; error?: ConnectorError }
interface Collected { source: DiscoveredIngestJob['sources'][number]; identity: SourceIdentity; previous?: SourceHealthProjection; skippedByCircuit: boolean; attempts: Attempt[]; observation?: TrustlineObservation; evidence?: unknown; error?: ConnectorError }
function durableId(prefix: string, ...parts: string[]) { return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex')}` }
function timestamp(clock: () => Date) { const value = clock(); if (!Number.isFinite(value.getTime())) throw new Error('clock must return a valid Date'); return value.toISOString() }
function category(code: SourceError['code']): SourceError['category'] {
  if (code === 'invalid_configuration' || code === 'invalid_asset') return 'configuration'
  if (code === 'request_failed' || code === 'request_aborted') return 'transport'
  if (code === 'non_200_response' || code === 'redirect_rejected') return 'http'
  if (code === 'network_mismatch') return 'network'
  if (code === 'stale_observation') return 'freshness'
  if (code === 'excluded_source') return 'policy'
  return 'payload'
}
function domainError(error: ConnectorError): SourceError {
  const parsed = sourceErrorCodeSchema.safeParse(error.code); const code = parsed.success ? parsed.data : 'request_failed'
  return { sourceId: error.sourceId, sourceUrl: error.sourceUrl, code, category: category(code), message: error.message, occurredAt: error.retrievedAt,
    ...(error.status === undefined ? {} : { httpStatus: error.status }), retryable: code === 'request_failed' || code === 'request_aborted' || (code === 'non_200_response' && ([408, 425, 429].includes(error.status ?? 0) || (error.status ?? 0) >= 500)) }
}

export function createTrustlineJobHandler(repositories: PersistenceRepositories, clock: () => Date = () => new Date(), options: TrustlineJobOptions = {}): WorkerJobHandler {
  const policy = options.resiliencePolicy ?? DEFAULT_POLICY
  return async ({ lease, job, signal }): Promise<PersistCompletedCycleInput> => {
    if (lease.metric !== 'trustline_count' || job.metric !== 'trustline_count') throw new Error('trustline handler received a different metric')
    if (lease.methodologyVersion !== TRUSTLINE_METHODOLOGY_VERSION || job.methodologyVersion !== TRUSTLINE_METHODOLOGY_VERSION) throw new Error('trustline methodology does not match the handler')
    const asset = creditAssetSchema.parse(job.asset)
    const networkIds = new Set(job.sources.map((source) => source.networkId)); const passphrases = new Set(job.sources.map((source) => source.networkPassphrase))
    if (networkIds.size !== 1 || passphrases.size !== 1) throw new Error('trustline sources must share one network')
    const network = networkIdentitySchema.parse({ id: job.sources[0]!.networkId, passphrase: job.sources[0]!.networkPassphrase })
    if (formatNetworkAssetKey(network.id, asset) !== lease.subjectKey || job.subjectKey !== lease.subjectKey) throw new Error('trustline asset does not match leased subject')
    const identities = job.sources.map((source) => sourceIdentitySchema.parse({ id: source.id, url: source.url, sourceClass: source.sourceClass, adapter: source.adapter, network }))
    const identityById = new Map(identities.map((identity) => [identity.id, identity])); const startedAt = timestamp(clock)
    const previousHealth = await repositories.getSourceHealthStates(job.sources.map((source) => source.id))
    const collected = await mapWithConcurrency(job.sources, policy.concurrency, async (source): Promise<Collected> => {
      const identity = identityById.get(source.id)!; const previous = previousHealth[source.id] as SourceHealthProjection | undefined; const decisionAt = timestamp(clock)
      if (!sourceCanAttempt(previous, decisionAt)) return { source, identity, previous, skippedByCircuit: true, attempts: [], error: { sourceId: source.id, sourceUrl: source.url, code: 'excluded_source', message: 'Source circuit is open until its next permitted attempt', retrievedAt: decisionAt } }
      const execution = await executeWithRetry<Attempt, ConnectorError>({ policy, signal, random: options.random ?? Math.random, sleep: options.sleep ?? abortableSleep,
        operation: async (attemptNumber) => {
          const attemptStartedAt = timestamp(clock)
          if (source.configurationError || source.adapter !== 'horizon' || source.sourceClass !== 'canonical_ledger') { const completedAt = timestamp(clock); return { error: { sourceId: source.id, sourceUrl: source.url, code: 'invalid_configuration', message: source.configurationError ?? 'Trustline state requires canonical-ledger Horizon sources', retrievedAt: completedAt, startedAt: attemptStartedAt, completedAt } } }
          try {
            const result = await fetchHorizonTrustlineObservation({ observationId: durableId('observation', lease.id, source.id), cycleId: lease.id, source: identity, asset, expectedNetwork: network, signal, endpointPolicy: options.endpointPolicy ?? {}, timeoutMs: options.timeoutMs ?? DEFAULT_HORIZON_TIMEOUT_MS, maxResponseBytes: options.maxResponseBytes ?? DEFAULT_HORIZON_MAX_RESPONSE_BYTES, clock })
            const completedAt = result.error?.retrievedAt ?? timestamp(clock)
            return result.error ? { error: { ...result.error, startedAt: attemptStartedAt, completedAt } } : { value: { attemptNumber, startedAt: attemptStartedAt, completedAt, observation: result.observation, evidence: result.evidence } }
          } catch (error) {
            if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
            const completedAt = timestamp(clock); return { error: { sourceId: source.id, sourceUrl: source.url, code: 'malformed_payload', message: 'Source result failed trustline contract validation', retrievedAt: completedAt, startedAt: attemptStartedAt, completedAt } }
          }
        } })
      const attempts: Attempt[] = execution.attempts.map((attempt, index) => attempt.value ?? { attemptNumber: index + 1, startedAt: (attempt.error as ConnectorError).startedAt!, completedAt: (attempt.error as ConnectorError).completedAt!, error: attempt.error })
      const final = attempts.at(-1)!; return { source, identity, previous, skippedByCircuit: false, attempts, observation: final.observation, evidence: final.evidence, error: final.error }
    })
    if (signal.aborted) throw new DOMException('Worker operation was cancelled', 'AbortError')
    const completedAt = timestamp(clock)
    const staleIds = new Set(collected.flatMap((result) => result.observation && (Date.parse(completedAt) - Date.parse(result.observation.provenance.sourceTimestamp!)) / 1_000 > trustlineMethodologyConfig.maximumObservationAgeSeconds ? [result.source.id] : []))
    const staleErrors: ConnectorError[] = collected.flatMap((result) => staleIds.has(result.source.id) ? [{ sourceId: result.source.id, sourceUrl: result.source.url, code: 'stale_observation', message: 'Trustline observation exceeds the maximum accepted ledger age', retrievedAt: completedAt }] : [])
    const errors = [...collected.flatMap((result) => result.error ? [result.error] : []), ...staleErrors]
    const reconciled = reconcileTrustlines({ cycleId: lease.id, snapshotId: durableId('snapshot', lease.id), asset, configuredSources: identities,
      observations: collected.flatMap((result) => result.observation && !staleIds.has(result.source.id) ? [result.observation] : []), sourceErrors: errors.map(domainError),
      priorDiscrepancyStates: await repositories.getDiscrepancyStates('trustline_count', lease.subjectKey), asOf: new Date(completedAt) })
    const healthStates = collected.map((result) => {
      if (result.skippedByCircuit && result.previous) return { ...result.previous, lastObservedAt: completedAt }
      return transitionSourceHealth({ sourceId: result.source.id, previous: result.previous, error: staleIds.has(result.source.id) ? staleErrors.find((error) => error.sourceId === result.source.id) : result.error, observedAt: completedAt, policy })
    })
    return {
      cycle: { id: lease.id, metric: 'trustline_count', subjectKey: lease.subjectKey, methodologyVersion: lease.methodologyVersion, idempotencyKey: lease.idempotencyKey, scheduledAt: lease.scheduledAt, startedAt, completedAt },
      attempts: collected.flatMap((result) => result.attempts.map((attempt) => ({ id: durableId('attempt', lease.id, result.source.id, String(attempt.attemptNumber)), sourceId: result.source.id, attemptNumber: attempt.attemptNumber, outcome: attempt.observation ? 'success' as const : 'failure' as const, startedAt: attempt.startedAt, completedAt: attempt.completedAt, httpStatus: attempt.observation ? 200 : attempt.error?.status ?? null, error: attempt.error ? { ...attempt.error } : null }))),
      readings: collected.flatMap((result) => {
        if (!result.observation) return []; const final = result.attempts.at(-1)!
        return [{ id: durableId('reading', lease.id, result.source.id), observationId: result.observation.observationId, attemptId: durableId('attempt', lease.id, result.source.id, String(final.attemptNumber)), sourceId: result.source.id, sourceIdentity: result.identity,
          normalizedValue: { kind: 'trustline_state', total: result.observation.total, states: result.observation.states, ledgerSequence: result.observation.ledgerSequence }, rawPayload: { observation: result.observation, evidence: result.evidence }, sourceTimestamp: result.observation.provenance.sourceTimestamp, retrievedAt: result.observation.provenance.retrievedAt }]
      }),
      sourceHealth: collected.map((result) => { const health = healthStates.find((candidate) => candidate.sourceId === result.source.id)!; const first = result.attempts[0]; const last = result.attempts.at(-1); return { id: durableId('health', lease.id, result.source.id), sourceId: result.source.id, state: health.state, latencyMs: !first || !last ? null : Math.max(0, Date.parse(last.completedAt) - Date.parse(first.startedAt)), details: { attemptCount: result.attempts.length, circuitState: health.circuitState, skippedByCircuit: result.skippedByCircuit, derivationFamily: result.observation?.derivation.family ?? null }, observedAt: completedAt } }),
      sourceHealthStates: healthStates, snapshot: reconciled.snapshot, discrepancyStates: reconciled.discrepancyStates, events: reconciled.events,
    }
  }
}
