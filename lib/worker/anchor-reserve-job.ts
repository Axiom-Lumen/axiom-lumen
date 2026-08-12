import { createHash } from 'node:crypto'
import {
  ANCHOR_RESERVE_METHODOLOGY_VERSION,
  anchorReserveMethodologyConfig,
  MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION,
  MZAR_RESERVE_CONNECTOR_PROFILE,
  mzarAnchorReserveMethodologyConfig,
  SUPPLY_METHODOLOGY_VERSION,
} from '../../config/methodology'
import {
  creditAssetSchema,
  formatNetworkAssetKey,
  networkIdentitySchema,
  sourceErrorCodeSchema,
  sourceIdentitySchema,
  type RawObservation,
  type SourceError,
} from '../contracts/domain'
import type { PersistCompletedCycleInput, PersistenceRepositories } from '../db/repositories'
import { reconcileAnchorReserve } from '../reconcile/anchor-reserve'
import { fetchAnchorReserveObservation, type AnchorReserveConnectorError } from '../stellar/anchor-reserve'
import { fetchMzarReserveObservation } from '../stellar/mzar-reserve'
import type { ResolveHost, SafeHttpsConnect } from '../stellar/safe-http'
import {
  abortableSleep,
  executeWithRetry,
  sourceCanAttempt,
  transitionSourceHealth,
  type SourceHealthProjection,
  type SourceResiliencePolicy,
} from './resilience'
import type { WorkerJobHandler } from './scheduler'

type AnchorReserveObservation = Extract<RawObservation, { metric: 'anchor_reserves' }>

const DEFAULT_POLICY: SourceResiliencePolicy = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 5_000, jitterRatio: 0.2, concurrency: 1, circuitFailureThreshold: 3, circuitCooldownMs: 60_000 }

function durableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex')}`
}

function timestamp(clock: () => Date) {
  const value = clock()
  if (!Number.isFinite(value.getTime())) throw new Error('clock must return a valid date')
  return value.toISOString()
}

function category(code: SourceError['code']): SourceError['category'] {
  if (['invalid_configuration', 'scope_mismatch', 'unit_mismatch'].includes(code)) return 'configuration'
  if (['request_failed', 'request_aborted'].includes(code)) return 'transport'
  if (['non_200_response', 'redirect_rejected'].includes(code)) return 'http'
  if (['stale_observation', 'period_mismatch', 'reference_unavailable'].includes(code)) return 'freshness'
  if (['unsafe_endpoint', 'excluded_source', 'domain_unverified'].includes(code)) return 'policy'
  return 'payload'
}

function domainError(error: AnchorReserveConnectorError): SourceError {
  const parsed = sourceErrorCodeSchema.safeParse(error.code)
  const code = parsed.success ? parsed.data : 'request_failed'
  return {
    sourceId: error.sourceId,
    sourceUrl: error.sourceUrl,
    code,
    category: category(code),
    message: error.message,
    occurredAt: error.retrievedAt,
    ...(error.status === undefined ? {} : { httpStatus: error.status }),
    retryable: code === 'request_failed' || code === 'request_aborted' ||
      (code === 'non_200_response' && ([408, 425, 429].includes(error.status ?? 0) || (error.status ?? 0) >= 500)),
  }
}

export interface AnchorReserveJobOptions {
  resiliencePolicy?: SourceResiliencePolicy
  resolve?: ResolveHost
  timeoutMs?: number
  maximumBytes?: number
  mzarTimeoutMs?: number
  maximumMzarIndexBytes?: number
  maximumMzarPdfBytes?: number
  random?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  connectImpl?: SafeHttpsConnect
  extractMzarPdfText?: (bytes: Uint8Array) => Promise<string>
}

export function createAnchorReserveJobHandler(
  repositories: PersistenceRepositories,
  clock: () => Date = () => new Date(),
  options: AnchorReserveJobOptions = {},
): WorkerJobHandler {
  const policy = options.resiliencePolicy ?? DEFAULT_POLICY
  return async ({ lease, job, signal }): Promise<PersistCompletedCycleInput> => {
    if (lease.metric !== 'anchor_reserves' || job.metric !== 'anchor_reserves') throw new Error('anchor reserve handler received a different metric')
    const expectedMethodology = job.connectorProfile === MZAR_RESERVE_CONNECTOR_PROFILE
      ? MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION
      : ANCHOR_RESERVE_METHODOLOGY_VERSION
    if (lease.methodologyVersion !== expectedMethodology || job.methodologyVersion !== expectedMethodology) throw new Error('anchor reserve methodology does not match its connector profile')
    const asset = creditAssetSchema.parse(job.asset)
    const source = job.sources[0]!
    const network = networkIdentitySchema.parse({ id: source.networkId, passphrase: source.networkPassphrase })
    if (formatNetworkAssetKey(network.id, asset) !== lease.subjectKey || job.subjectKey !== lease.subjectKey) throw new Error('anchor reserve asset does not match leased subject')
    const identity = sourceIdentitySchema.parse({ id: source.id, url: source.url, sourceClass: source.sourceClass, adapter: source.adapter, network })
    const startedAt = timestamp(clock)
    const priorHealth = (await repositories.getSourceHealthStates([source.id]))[source.id] as SourceHealthProjection | undefined
    const canAttempt = sourceCanAttempt(priorHealth, startedAt)
    let attempts: Array<{ attemptNumber: number; startedAt: string; completedAt: string; observation?: AnchorReserveObservation; evidence?: unknown; error?: AnchorReserveConnectorError }> = []
    let preflightError: AnchorReserveConnectorError | undefined
    if (!canAttempt) {
      preflightError = { sourceId: source.id, sourceUrl: source.url, code: 'excluded_source', message: 'Source circuit is open until its next permitted attempt', retrievedAt: startedAt }
    } else {
      const execution = await executeWithRetry({
        policy,
        signal,
        random: options.random ?? Math.random,
        sleep: options.sleep ?? abortableSleep,
        operation: async (attemptNumber) => {
          const attemptStartedAt = timestamp(clock)
          if (source.configurationError || source.adapter !== 'anchor' || source.sourceClass !== 'anchor_self_reported') {
            const completedAt = timestamp(clock)
            return { error: { sourceId: source.id, sourceUrl: source.url, code: 'invalid_configuration' as const, message: source.configurationError ?? 'Reserve comparison requires a verified anchor source', retrievedAt: completedAt, startedAt: attemptStartedAt, completedAt } }
          }
          const connector = job.connectorProfile === MZAR_RESERVE_CONNECTOR_PROFILE
            ? fetchMzarReserveObservation
            : fetchAnchorReserveObservation
          const result = await connector({
            observationId: durableId('observation', lease.id, source.id),
            cycleId: lease.id,
            anchorId: job.anchorId,
            source: identity,
            asset,
            resolve: options.resolve,
            connectImpl: options.connectImpl,
            timeoutMs: job.connectorProfile === MZAR_RESERVE_CONNECTOR_PROFILE ? options.mzarTimeoutMs : options.timeoutMs,
            ...(job.connectorProfile === MZAR_RESERVE_CONNECTOR_PROFILE
              ? {
                  maximumIndexBytes: options.maximumMzarIndexBytes,
                  maximumPdfBytes: options.maximumMzarPdfBytes,
                  extractPdfText: options.extractMzarPdfText,
                }
              : { maximumBytes: options.maximumBytes }),
            signal,
            clock,
          })
          const completedAt = 'error' in result ? result.error.retrievedAt : result.observation.provenance.retrievedAt
          return 'error' in result
            ? { error: { ...result.error, startedAt: attemptStartedAt, completedAt } }
            : { value: { attemptNumber, startedAt: attemptStartedAt, completedAt, observation: result.observation, evidence: result.evidence } }
        },
      })
      attempts = execution.attempts.map((attempt, index) => attempt.value ?? {
        attemptNumber: index + 1,
        startedAt: (attempt.error as AnchorReserveConnectorError).startedAt ?? startedAt,
        completedAt: (attempt.error as AnchorReserveConnectorError).completedAt ?? (attempt.error as AnchorReserveConnectorError).retrievedAt,
        error: attempt.error as AnchorReserveConnectorError,
      })
    }
    if (signal.aborted) throw new DOMException('Worker operation was cancelled', 'AbortError')
    const completedAt = timestamp(clock)
    const final = attempts.at(-1)
    let observation = final?.observation
    const errors: AnchorReserveConnectorError[] = preflightError ? [preflightError] : final?.error ? [final.error] : []
    const contextualErrors: SourceError[] = []
    if (observation) {
      const attestationAge = (Date.parse(completedAt) - Date.parse(observation.attestationPeriodEnd)) / 1_000
      const maximumFutureSkew = job.connectorProfile === MZAR_RESERVE_CONNECTOR_PROFILE
        ? mzarAnchorReserveMethodologyConfig.maximumReferenceSkewSeconds
        : anchorReserveMethodologyConfig.maximumPeriodSkewSeconds
      const publishedFutureSkew = (Date.parse(observation.publishedAt) - Date.parse(completedAt)) / 1_000
      if (attestationAge < -maximumFutureSkew || publishedFutureSkew > maximumFutureSkew) {
        errors.push({ sourceId: source.id, sourceUrl: source.url, code: 'period_mismatch', message: 'Reserve attestation timestamps are ahead of the collection boundary', retrievedAt: completedAt, status: 200 })
        observation = undefined
      } else if (attestationAge > (job.connectorProfile === MZAR_RESERVE_CONNECTOR_PROFILE
        ? mzarAnchorReserveMethodologyConfig.maximumReportCutoffAgeSeconds
        : anchorReserveMethodologyConfig.maximumAttestationAgeSeconds)) {
        errors.push({ sourceId: source.id, sourceUrl: source.url, code: 'stale_observation', message: 'Reserve attestation exceeds the maximum accepted age', retrievedAt: completedAt, status: 200 })
        observation = undefined
      }
    }
    const reference = job.connectorProfile === MZAR_RESERVE_CONNECTOR_PROFILE
      ? observation
        ? await repositories.getSupplyReferenceAt(lease.subjectKey, observation.attestationPeriodEnd, mzarAnchorReserveMethodologyConfig.maximumReferenceSkewSeconds)
        : null
      : await repositories.getLatestSupplyReference(lease.subjectKey)
    let usableReference = reference
    const referenceAge = reference ? (Date.parse(completedAt) - Date.parse(reference.ledgerClosedAt)) / 1_000 : Number.POSITIVE_INFINITY
    const invalidCurrentReference = job.connectorProfile === 'axiom_json_v1' &&
      (referenceAge < -anchorReserveMethodologyConfig.maximumPeriodSkewSeconds || referenceAge > anchorReserveMethodologyConfig.maximumReferenceAgeSeconds)
    if (!reference || reference.methodologyVersion !== SUPPLY_METHODOLOGY_VERSION || invalidCurrentReference) {
      contextualErrors.push({ sourceId: null, sourceUrl: null, code: 'reference_unavailable', category: 'freshness', message: job.connectorProfile === MZAR_RESERVE_CONNECTOR_PROFILE ? 'A persisted historical supply reference at the mZAR report cutoff is unavailable' : 'A current persisted on-chain supply reference is unavailable', occurredAt: completedAt, retryable: false })
      usableReference = null
    }
    const maximumReferenceSkew = job.connectorProfile === MZAR_RESERVE_CONNECTOR_PROFILE
      ? mzarAnchorReserveMethodologyConfig.maximumReferenceSkewSeconds
      : anchorReserveMethodologyConfig.maximumPeriodSkewSeconds
    if (observation && usableReference && Math.abs(Date.parse(observation.attestationPeriodEnd) - Date.parse(usableReference.ledgerClosedAt)) / 1_000 > maximumReferenceSkew) {
      errors.push({ sourceId: source.id, sourceUrl: source.url, code: 'period_mismatch', message: 'Reserve and on-chain supply periods are not commensurate', retrievedAt: completedAt, status: 200 })
      observation = undefined
    }
    const prior = (await repositories.getDiscrepancyStates('anchor_reserves', lease.subjectKey, lease.methodologyVersion))[source.id]
    const reconciled = reconcileAnchorReserve({
      cycleId: lease.id,
      snapshotId: durableId('snapshot', lease.id),
      asset,
      anchorId: job.anchorId,
      configuredSource: identity,
      observation,
      sourceErrors: [...errors.map(domainError), ...contextualErrors],
      supplyReference: usableReference,
      priorState: prior,
      methodologyVersion: expectedMethodology,
      asOf: new Date(completedAt),
    })
    const healthError = errors.at(-1)
    const healthState = canAttempt
      ? transitionSourceHealth({ sourceId: source.id, previous: priorHealth, error: healthError, observedAt: completedAt, policy })
      : priorHealth!
    const successfulAttempt = attempts.findLast((attempt) => attempt.observation)
    return {
      cycle: { id: lease.id, metric: 'anchor_reserves', subjectKey: lease.subjectKey, methodologyVersion: lease.methodologyVersion, idempotencyKey: lease.idempotencyKey, scheduledAt: lease.scheduledAt, startedAt, completedAt },
      attempts: attempts.map((attempt) => ({
        id: durableId('attempt', lease.id, source.id, String(attempt.attemptNumber)),
        sourceId: source.id,
        attemptNumber: attempt.attemptNumber,
        outcome: attempt.observation ? 'success' as const : 'failure' as const,
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        httpStatus: attempt.observation ? 200 : attempt.error?.status ?? null,
        error: attempt.error ? { ...attempt.error } : null,
      })),
      readings: final?.observation && successfulAttempt ? [{
        id: durableId('reading', lease.id, source.id),
        observationId: final.observation.observationId,
        attemptId: durableId('attempt', lease.id, source.id, String(successfulAttempt.attemptNumber)),
        sourceId: source.id,
        sourceIdentity: identity,
        normalizedValue: { kind: 'amount', value: final.observation.amount },
        rawPayload: {
          observation: final.observation,
          evidence: final.evidence,
          supplyReference: usableReference ? {
            ...usableReference,
            amount: usableReference.amount.toString(),
          } : null,
        },
        sourceTimestamp: final.observation.provenance.sourceTimestamp,
        retrievedAt: final.observation.provenance.retrievedAt,
      }] : [],
      sourceHealth: [{ id: durableId('health', lease.id, source.id), sourceId: source.id, state: healthState.state, details: { attemptCount: attempts.length, circuitState: healthState.circuitState, anchorId: job.anchorId }, observedAt: completedAt }],
      sourceHealthStates: [healthState],
      snapshot: reconciled.snapshot,
      discrepancyStates: reconciled.discrepancyStates,
      events: reconciled.events,
    }
  }
}
