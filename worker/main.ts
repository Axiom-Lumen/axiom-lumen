import { createDatabaseClient } from '../lib/db/client'
import { createPersistenceRepositories } from '../lib/db/repositories'
import { createSchedulerRepository } from '../lib/db/scheduler-repository'
import { LATEST_LEDGER_METHODOLOGY_VERSION } from '../lib/reconcile/latest-ledger'
import { parseHorizonHostList } from '../lib/stellar/horizon'
import { parseSourceResilienceConfig, parseWorkerConfig } from '../lib/worker/config'
import { serializeWorkerError } from '../lib/worker/errors'
import { createLatestLedgerJobHandler } from '../lib/worker/latest-ledger-job'
import { runSchedulerContinuously, runSchedulerOnce } from '../lib/worker/scheduler'

function executionMode(arguments_: readonly string[]) {
  const once = arguments_.includes('--once')
  const continuous = arguments_.includes('--continuous')
  if (once === continuous) throw new Error('Specify exactly one of --once or --continuous')
  return once ? 'once' : 'continuous'
}

async function main() {
  const mode = executionMode(process.argv.slice(2))
  const options = parseWorkerConfig()
  const { timeoutMs, maxResponseBytes, ...resiliencePolicy } = parseSourceResilienceConfig()
  const client = createDatabaseClient()
  const persistenceRepositories = createPersistenceRepositories(client)
  const schedulerRepository = createSchedulerRepository(client)
  const controller = new AbortController()
  const stop = () => controller.abort(new DOMException('Worker shutdown requested', 'AbortError'))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    const dependencies = {
      schedulerRepository,
      persistenceRepositories,
      methodologyVersion: LATEST_LEDGER_METHODOLOGY_VERSION,
      handlers: {
        latest_ledger: createLatestLedgerJobHandler(persistenceRepositories, () => new Date(), {
          endpointPolicy: {
            allowedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_ALLOWED_HOSTS),
            deniedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_DENIED_HOSTS),
          },
          resiliencePolicy,
          timeoutMs,
          maxResponseBytes,
        }),
      },
    }
    if (mode === 'once') {
      const summary = await runSchedulerOnce(dependencies, options, controller.signal)
      console.log(JSON.stringify({ event: 'worker_cycle_complete', workerId: options.workerId, ...summary }))
    } else {
      console.log(JSON.stringify({ event: 'worker_started', workerId: options.workerId }))
      await runSchedulerContinuously(dependencies, options, controller.signal)
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await client.pool.end()
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    event: 'worker_failed',
    ...serializeWorkerError(error),
  }))
  process.exitCode = 1
})
