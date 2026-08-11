import { describe, expect, it, vi } from 'vitest'
import type { PersistenceRepositories } from '../../lib/db/repositories'
import type { ClaimedCycle, DiscoveredIngestJob, SchedulerRepository } from '../../lib/db/scheduler-repository'
import { runSchedulerOnce, scheduledCycle, type SchedulerDependencies } from '../../lib/worker/scheduler'

const now = '2026-08-10T10:00:00.000Z'
const options = {
  workerId: 'worker-a',
  intervalSeconds: 60,
  concurrency: 2,
  leaseDurationMs: 30_000,
  maxAttempts: 3,
  pollIntervalMs: 5_000,
}

function job(subjectKey: 'public' | 'testnet' | 'futurenet'): DiscoveredIngestJob {
  return {
    metric: 'latest_ledger',
    subjectKey,
    methodologyVersion: 'latest-ledger-v0.2',
    sources: [{
      id: `source-${subjectKey}`,
      url: `https://${subjectKey}.example`,
      sourceClass: 'canonical_ledger',
      adapter: 'horizon',
      upstreamId: null,
      networkId: subjectKey,
      networkPassphrase: 'passphrase',
    }],
  }
}

function leaseFor(discovered: DiscoveredIngestJob): ClaimedCycle {
  return {
    ...scheduledCycle(discovered, now),
    leaseOwner: 'worker-a',
    leaseToken: 1,
    leaseExpiresAt: '2026-08-10T10:00:30.000Z',
    attemptCount: 1,
  }
}

function dependencies(jobs: DiscoveredIngestJob[], leases: ClaimedCycle[], handler: SchedulerDependencies['handlers']['latest_ledger']) {
  const queue = [...leases]
  const schedulerRepository = {
    reapExpiredLeases: vi.fn(async () => ({ retried: 0, abandoned: 0, finalized: 0 })),
    discoverLatestLedgerJobs: vi.fn(async () => jobs),
    discoverSupplyJobs: vi.fn(async () => []),
    discoverDepthJobs: vi.fn(async () => []),
    discoverTrustlineJobs: vi.fn(async () => []),
    ensureScheduledCycle: vi.fn(async () => true),
    claimNextCycle: vi.fn(async () => queue.shift() ?? null),
    renewLease: vi.fn(async () => true),
    acknowledgeFinalized: vi.fn(async () => true),
    releaseLease: vi.fn(async () => true),
    failLease: vi.fn(async () => true),
  } as unknown as SchedulerRepository
  const persistenceRepositories = {
    persistCompletedCycle: vi.fn(async () => ({ status: 'inserted', cycleId: 'cycle' })),
  } as unknown as PersistenceRepositories
  return {
    value: {
      schedulerRepository,
      persistenceRepositories,
      handlers: { latest_ledger: handler },
      methodologyVersion: 'latest-ledger-v0.2',
      clock: () => new Date(now),
    } satisfies SchedulerDependencies,
    schedulerRepository,
    persistenceRepositories,
  }
}

describe('worker scheduler', () => {
  it('derives stable cycle identities from the job and schedule boundary', () => {
    const first = scheduledCycle(job('public'), now)
    expect(scheduledCycle(job('public'), now)).toEqual(first)
    expect(scheduledCycle(job('testnet'), now).id).not.toBe(first.id)
  })

  it('bounds concurrent handlers while draining claimed work', async () => {
    const jobs = (['public', 'testnet', 'futurenet'] as const).map(job)
    let active = 0
    let maximumActive = 0
    const handler = vi.fn(async ({ lease }: { lease: ClaimedCycle }) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return { cycle: { id: lease.id } } as never
    })
    const fixture = dependencies(jobs, jobs.map(leaseFor), handler)

    const result = await runSchedulerOnce(fixture.value, options)

    expect(result).toMatchObject({ scheduled: 3, claimed: 3, completed: 3, failed: 0 })
    expect(maximumActive).toBe(2)
    expect(fixture.persistenceRepositories.persistCompletedCycle).toHaveBeenCalledTimes(3)
  })

  it('acknowledges a durable winner when an overlapping retry resolves as a duplicate', async () => {
    const discovered = job('public')
    const handler = vi.fn(async () => ({ cycle: { id: 'winner' } } as never))
    const fixture = dependencies([discovered], [leaseFor(discovered)], handler)
    vi.mocked(fixture.persistenceRepositories.persistCompletedCycle).mockResolvedValue({
      status: 'duplicate',
      cycleId: leaseFor(discovered).id,
    })

    const result = await runSchedulerOnce(fixture.value, options)

    expect(result).toMatchObject({ duplicates: 1, completed: 0, failed: 0 })
    expect(fixture.schedulerRepository.acknowledgeFinalized).toHaveBeenCalledOnce()
    expect(fixture.schedulerRepository.failLease).not.toHaveBeenCalled()
  })

  it('discovers and dispatches the registered supply methodology without replacing latest-ledger jobs', async () => {
    const supplyJob: DiscoveredIngestJob = {
      metric: 'circulating_supply',
      subjectKey: `public:USDC:G${'A'.repeat(55)}`,
      methodologyVersion: 'onchain-asset-supply-v0.1',
      asset: { kind: 'credit', code: 'USDC', issuer: `G${'A'.repeat(55)}` },
      sources: [{
        id: 'supply-source',
        url: 'https://supply.example',
        sourceClass: 'canonical_ledger',
        adapter: 'horizon',
        upstreamId: null,
        networkId: 'public',
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
      }],
    }
    const supplyLease = leaseFor(supplyJob)
    const supplyHandler = vi.fn(async () => ({ cycle: { id: supplyLease.id } } as never))
    const fixture = dependencies([], [supplyLease], vi.fn())
    vi.mocked(fixture.schedulerRepository.discoverSupplyJobs).mockResolvedValue([supplyJob])
    const dependenciesWithSupply: SchedulerDependencies = {
      ...fixture.value,
      supplyMethodologyVersion: 'onchain-asset-supply-v0.1',
      handlers: { ...fixture.value.handlers, circulating_supply: supplyHandler },
    }

    const result = await runSchedulerOnce(dependenciesWithSupply, options)

    expect(result).toMatchObject({ scheduled: 1, claimed: 1, completed: 1 })
    expect(fixture.schedulerRepository.discoverLatestLedgerJobs).toHaveBeenCalledWith('latest-ledger-v0.2')
    expect(fixture.schedulerRepository.discoverSupplyJobs).toHaveBeenCalledWith('onchain-asset-supply-v0.1')
    expect(supplyHandler).toHaveBeenCalledOnce()
  })

  it('discovers and dispatches trustline-state jobs through their registered handler', async () => {
    const trustlineJob: DiscoveredIngestJob = {
      metric: 'trustline_count', subjectKey: `public:USDC:G${'A'.repeat(55)}`, methodologyVersion: 'trustline-state-v0.1',
      asset: { kind: 'credit', code: 'USDC', issuer: `G${'A'.repeat(55)}` },
      sources: [{ id: 'trustline-source', url: 'https://trustlines.example', sourceClass: 'canonical_ledger', adapter: 'horizon', upstreamId: null, networkId: 'public', networkPassphrase: 'Public Global Stellar Network ; September 2015' }],
    }
    const trustlineLease = leaseFor(trustlineJob)
    const handler = vi.fn(async () => ({ cycle: { id: trustlineLease.id } } as never))
    const fixture = dependencies([], [trustlineLease], vi.fn())
    vi.mocked(fixture.schedulerRepository.discoverTrustlineJobs).mockResolvedValue([trustlineJob])
    const configured: SchedulerDependencies = { ...fixture.value, trustlineMethodologyVersion: 'trustline-state-v0.1', handlers: { ...fixture.value.handlers, trustline_count: handler } }

    expect(await runSchedulerOnce(configured, options)).toMatchObject({ scheduled: 1, claimed: 1, completed: 1 })
    expect(fixture.schedulerRepository.discoverTrustlineJobs).toHaveBeenCalledWith('trustline-state-v0.1')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('executes a claimed lease from its immutable job snapshot after source configuration changes', async () => {
    const original = job('public')
    const lease = leaseFor(original)
    const changed = {
      ...original,
      sources: [{ ...original.sources[0]!, url: 'https://replacement.example' }],
    }
    const handler = vi.fn(async () => ({ cycle: { id: lease.id } } as never))
    const fixture = dependencies([changed], [lease], handler)

    await runSchedulerOnce(fixture.value, options)

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      job: expect.objectContaining({
        sources: [expect.objectContaining({ url: 'https://public.example' })],
      }),
    }))
  })

  it('releases a claimed lease when graceful shutdown cancels its handler', async () => {
    const discovered = job('public')
    const controller = new AbortController()
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const handler = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      started()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
      })
      throw new Error('unreachable')
    })
    const fixture = dependencies([discovered], [leaseFor(discovered)], handler)
    const pending = runSchedulerOnce(fixture.value, options, controller.signal)
    await startedPromise
    controller.abort()

    const result = await pending

    expect(result.cancelled).toBe(1)
    expect(fixture.schedulerRepository.releaseLease).toHaveBeenCalledOnce()
    expect(fixture.persistenceRepositories.persistCompletedCycle).not.toHaveBeenCalled()
  })
})
