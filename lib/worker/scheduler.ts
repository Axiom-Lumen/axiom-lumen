import { createHash } from 'node:crypto'
import type { PersistCompletedCycleInput, PersistenceRepositories } from '../db/repositories'
import type {
  ClaimedCycle,
  DiscoveredIngestJob,
  SchedulerRepository,
  ScheduledCycleInput,
} from '../db/scheduler-repository'

export interface SchedulerOptions {
  workerId: string
  intervalSeconds: number
  concurrency: number
  leaseDurationMs: number
  maxAttempts: number
  pollIntervalMs: number
}

export interface WorkerJobContext {
  lease: ClaimedCycle
  job: DiscoveredIngestJob
  signal: AbortSignal
}

export type WorkerJobHandler = (context: WorkerJobContext) => Promise<PersistCompletedCycleInput>
export type WorkerJobHandlers = Readonly<Partial<Record<ClaimedCycle['metric'], WorkerJobHandler>>>

export interface SchedulerDependencies {
  schedulerRepository: SchedulerRepository
  persistenceRepositories: PersistenceRepositories
  handlers: WorkerJobHandlers
  methodologyVersion: string
  clock?: () => Date
}

function assertOptions(options: SchedulerOptions) {
  if (!options.workerId.trim()) throw new Error('workerId must not be empty')
  for (const [name, value] of Object.entries({
    intervalSeconds: options.intervalSeconds,
    concurrency: options.concurrency,
    leaseDurationMs: options.leaseDurationMs,
    maxAttempts: options.maxAttempts,
    pollIntervalMs: options.pollIntervalMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
  }
}

function scheduledTime(now: Date, intervalSeconds: number) {
  const intervalMs = intervalSeconds * 1000
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs).toISOString()
}

export function scheduledCycle(job: DiscoveredIngestJob, at: string): ScheduledCycleInput {
  const idempotencyKey = `${job.metric}:${job.subjectKey}:${job.methodologyVersion}:${at}`
  const digest = createHash('sha256').update(idempotencyKey).digest('hex')
  return {
    id: `cycle_${digest}`,
    metric: job.metric,
    subjectKey: job.subjectKey,
    methodologyVersion: job.methodologyVersion,
    idempotencyKey,
    scheduledAt: at,
  }
}

function abortError() {
  return new DOMException('Worker operation was cancelled', 'AbortError')
}

async function abortableDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout)
      reject(abortError())
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isAbort(error: unknown, signal: AbortSignal) {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError')
}

export async function runSchedulerOnce(
  dependencies: SchedulerDependencies,
  options: SchedulerOptions,
  signal: AbortSignal = new AbortController().signal,
) {
  assertOptions(options)
  const clock = dependencies.clock ?? (() => new Date())
  const now = clock()
  if (!Number.isFinite(now.getTime())) throw new Error('clock must return a valid Date')
  const nowIso = now.toISOString()
  const reaped = await dependencies.schedulerRepository.reapExpiredLeases(nowIso, options.maxAttempts)
  const jobs = await dependencies.schedulerRepository.discoverLatestLedgerJobs(dependencies.methodologyVersion)
  const jobsByKey = new Map(jobs.map((job) => [`${job.metric}:${job.subjectKey}`, job]))
  const at = scheduledTime(now, options.intervalSeconds)
  let scheduled = 0
  for (const job of jobs) {
    if (await dependencies.schedulerRepository.ensureScheduledCycle(scheduledCycle(job, at))) scheduled += 1
  }

  const summary = { scheduled, claimed: 0, completed: 0, duplicates: 0, failed: 0, cancelled: 0, reaped }
  async function consume() {
    while (!signal.aborted) {
      const claimedAt = clock().toISOString()
      const lease = await dependencies.schedulerRepository.claimNextCycle({
        workerId: options.workerId,
        now: claimedAt,
        leaseDurationMs: options.leaseDurationMs,
      })
      if (!lease) return
      summary.claimed += 1
      const job = jobsByKey.get(`${lease.metric}:${lease.subjectKey}`)
      const handler = dependencies.handlers[lease.metric]
      if (!job || !handler) {
        await dependencies.schedulerRepository.failLease(lease, clock().toISOString(), new Error('No registered job handler'))
        summary.failed += 1
        continue
      }

      const jobController = new AbortController()
      const jobSignal = AbortSignal.any([signal, jobController.signal])
      let renewing = false
      const heartbeat = setInterval(async () => {
        if (renewing || jobSignal.aborted) return
        renewing = true
        try {
          const renewed = await dependencies.schedulerRepository.renewLease(
            lease,
            clock().toISOString(),
            options.leaseDurationMs,
          )
          if (!renewed) jobController.abort()
        } catch {
          jobController.abort()
        } finally {
          renewing = false
        }
      }, Math.max(250, Math.floor(options.leaseDurationMs / 3)))

      try {
        const batch = await handler({ lease, job, signal: jobSignal })
        if (jobSignal.aborted) throw abortError()
        const persisted = await dependencies.persistenceRepositories.persistCompletedCycle(batch)
        const acknowledged = await dependencies.schedulerRepository.acknowledgeFinalized(lease, clock().toISOString())
        if (!acknowledged) throw new Error(`worker lost lease ${lease.id} before acknowledgement`)
        if (persisted.status === 'duplicate') summary.duplicates += 1
        else summary.completed += 1
      } catch (error) {
        if (isAbort(error, jobSignal)) {
          await dependencies.schedulerRepository.releaseLease(lease, clock().toISOString())
          summary.cancelled += 1
        } else {
          await dependencies.schedulerRepository.failLease(lease, clock().toISOString(), error)
          summary.failed += 1
        }
      } finally {
        clearInterval(heartbeat)
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, () => consume()))
  return summary
}

export async function runSchedulerContinuously(
  dependencies: SchedulerDependencies,
  options: SchedulerOptions,
  signal: AbortSignal,
) {
  while (!signal.aborted) {
    await runSchedulerOnce(dependencies, options, signal)
    await abortableDelay(options.pollIntervalMs, signal).catch((error) => {
      if (!isAbort(error, signal)) throw error
    })
  }
}
