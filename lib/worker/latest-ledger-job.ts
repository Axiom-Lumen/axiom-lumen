import { createHash } from 'node:crypto'
import { networkIdSchema } from '../contracts/domain'
import type { PersistenceRepositories, PersistCompletedCycleInput } from '../db/repositories'
import { LATEST_LEDGER_METHODOLOGY_VERSION, reconcileLatestLedgerDomain } from '../reconcile/latest-ledger'
import { fetchLatestLedgersFromHorizonSources } from '../stellar/horizon'
import type { HorizonEndpointPolicy } from '../stellar/horizon'
import type { WorkerJobHandler } from './scheduler'

function durableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex')}`
}

function sourceHealthState(code: string | undefined) {
  if (!code) return 'healthy' as const
  if (code === 'network_mismatch') return 'network_mismatched' as const
  if (code === 'malformed_payload' || code === 'empty_ledger_records' || code === 'empty_records') {
    return 'malformed' as const
  }
  if (code === 'stale_observation') return 'stale' as const
  if (code === 'redirect_rejected' || code === 'invalid_configuration' || code === 'excluded_source') {
    return 'rejected' as const
  }
  return 'unreachable' as const
}

export function createLatestLedgerJobHandler(
  repositories: PersistenceRepositories,
  clock: () => Date = () => new Date(),
  endpointPolicy: HorizonEndpointPolicy = {},
): WorkerJobHandler {
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

    const startedAt = clock().toISOString()
    const fetched = await fetchLatestLedgersFromHorizonSources({
      sources: job.sources.map((source) => ({ id: source.id, url: source.url })),
      expectedNetworkPassphrase: networkPassphrase,
      clock,
      signal,
      endpointPolicy,
    })
    if (signal.aborted) throw new DOMException('Worker operation was cancelled', 'AbortError')
    const priorDiscrepancyStates = await repositories.getDiscrepancyStates('latest_ledger', lease.subjectKey)
    const network = { id: networkIdSchema.parse(lease.subjectKey), passphrase: networkPassphrase }
    const sourcesById = new Map(job.sources.map((source) => [source.id, source]))
    const observations = fetched.observations.map((observation) => {
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
      observations,
      sourceErrors: fetched.source_errors,
      sourcesConfigured: fetched.sources_configured,
      sourcesExcluded: fetched.sources_excluded,
      asOf: new Date(fetched.retrieved_at),
      network,
      priorDiscrepancyStates,
    })

    const errorsBySource = new Map(fetched.source_errors.map((error) => [error.sourceId, error]))
    const contributionBySource = new Map(reconciled.snapshot.contributions.map((item) => [item.sourceId, item]))
    const attempts = job.sources.map((source) => {
      const error = errorsBySource.get(source.id)
      return {
        id: durableId('attempt', lease.id, source.id),
        sourceId: source.id,
        attemptNumber: lease.attemptCount,
        outcome: error ? ('failure' as const) : ('success' as const),
        startedAt,
        completedAt: fetched.retrieved_at,
        httpStatus: error?.status ?? (error ? null : 200),
        error: error ? { ...error } : null,
      }
    })
    const attemptBySource = new Map(attempts.map((attempt) => [attempt.sourceId, attempt.id]))

    return {
      cycle: {
        id: lease.id,
        metric: 'latest_ledger',
        subjectKey: lease.subjectKey,
        methodologyVersion: lease.methodologyVersion,
        idempotencyKey: lease.idempotencyKey,
        scheduledAt: lease.scheduledAt,
        startedAt,
        completedAt: fetched.retrieved_at,
      },
      attempts,
      readings: observations.map((observation) => {
        const contribution = contributionBySource.get(observation.sourceId)
        const attemptId = attemptBySource.get(observation.sourceId)
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
      sourceHealth: job.sources.map((source) => ({
        id: durableId('health', lease.id, source.id),
        sourceId: source.id,
        state: sourceHealthState(errorsBySource.get(source.id)?.code),
        details: errorsBySource.has(source.id) ? { error: errorsBySource.get(source.id) } : {},
        observedAt: fetched.retrieved_at,
      })),
      snapshot: reconciled.snapshot,
      discrepancyStates: reconciled.discrepancyStates,
      events: reconciled.events,
    }
  }
}
