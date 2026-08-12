import { createDatabaseClient } from '../lib/db/client'
import { createPersistenceRepositories } from '../lib/db/repositories'
import { createAnchorCaseRepository } from '../lib/db/anchor-case-repository'
import { createSchedulerRepository } from '../lib/db/scheduler-repository'
import { LATEST_LEDGER_METHODOLOGY_VERSION } from '../lib/reconcile/latest-ledger'
import { ANCHOR_RESERVE_METHODOLOGY_VERSION, DEPTH_RECONCILIATION_METHODOLOGY_VERSION, SUPPLY_METHODOLOGY_VERSION, TRUSTLINE_METHODOLOGY_VERSION } from '../config/methodology'
import { parseHorizonHostList } from '../lib/stellar/horizon'
import { parseAnchorWorkflowConfig, parseSourceResilienceConfig, parseWorkerConfig } from '../lib/worker/config'
import { parseContactSecretKeyring } from '../lib/anchor/contact-secret'
import { serializeWorkerError } from '../lib/worker/errors'
import { createLatestLedgerJobHandler } from '../lib/worker/latest-ledger-job'
import { createSupplyJobHandler } from '../lib/worker/supply-job'
import { createDepthJobHandler } from '../lib/worker/depth-job'
import { createTrustlineJobHandler } from '../lib/worker/trustline-job'
import { createAnchorReserveJobHandler } from '../lib/worker/anchor-reserve-job'
import { runSchedulerContinuously, runSchedulerOnce } from '../lib/worker/scheduler'
import { runAnchorWorkflowContinuously, runAnchorWorkflowOnce } from '../lib/worker/anchor-case-workflow'

function executionMode(arguments_: readonly string[]) {
  const once = arguments_.includes('--once')
  const continuous = arguments_.includes('--continuous')
  if (once === continuous) throw new Error('Specify exactly one of --once or --continuous')
  return once ? 'once' : 'continuous'
}

async function main() {
  const mode = executionMode(process.argv.slice(2))
  const options = parseWorkerConfig()
  const anchorWorkflowConfig = parseAnchorWorkflowConfig()
  const contactSecretKeyring = process.env.ANCHOR_CONTACT_SECRET_KEYS || process.env.ANCHOR_CONTACT_ACTIVE_KEY_ID
    ? parseContactSecretKeyring()
    : undefined
  const { timeoutMs, maxResponseBytes, ...resiliencePolicy } = parseSourceResilienceConfig()
  const client = createDatabaseClient()
  const persistenceRepositories = createPersistenceRepositories(client)
  const schedulerRepository = createSchedulerRepository(client)
  const anchorCaseRepository = createAnchorCaseRepository(client)
  const controller = new AbortController()
  const stop = () => controller.abort(new DOMException('Worker shutdown requested', 'AbortError'))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    const dependencies = {
      schedulerRepository,
      persistenceRepositories,
      methodologyVersion: LATEST_LEDGER_METHODOLOGY_VERSION,
      supplyMethodologyVersion: SUPPLY_METHODOLOGY_VERSION,
      depthMethodologyVersion: DEPTH_RECONCILIATION_METHODOLOGY_VERSION,
      trustlineMethodologyVersion: TRUSTLINE_METHODOLOGY_VERSION,
      anchorReserveMethodologyVersion: ANCHOR_RESERVE_METHODOLOGY_VERSION,
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
        circulating_supply: createSupplyJobHandler(persistenceRepositories, () => new Date(), {
          endpointPolicy: {
            allowedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_ALLOWED_HOSTS),
            deniedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_DENIED_HOSTS),
          },
          resiliencePolicy,
          timeoutMs,
          maxResponseBytes,
        }),
        order_book_depth: createDepthJobHandler(persistenceRepositories, () => new Date(), {
          endpointPolicy: {
            allowedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_ALLOWED_HOSTS),
            deniedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_DENIED_HOSTS),
          },
          resiliencePolicy,
          timeoutMs,
          maxResponseBytes,
        }),
        trustline_count: createTrustlineJobHandler(persistenceRepositories, () => new Date(), {
          endpointPolicy: {
            allowedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_ALLOWED_HOSTS),
            deniedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_DENIED_HOSTS),
          },
          resiliencePolicy,
          timeoutMs,
          maxResponseBytes,
        }),
        anchor_reserves: createAnchorReserveJobHandler(persistenceRepositories, () => new Date(), {
          resiliencePolicy,
        }),
      },
    }
    if (mode === 'once') {
      const summary = await runSchedulerOnce(dependencies, options, controller.signal)
      const anchorWorkflow = await runAnchorWorkflowOnce({ repository: anchorCaseRepository, keyring: contactSecretKeyring }, anchorWorkflowConfig, options.workerId, controller.signal)
      console.log(JSON.stringify({ event: 'worker_cycle_complete', workerId: options.workerId, ...summary, anchorWorkflow }))
    } else {
      console.log(JSON.stringify({ event: 'worker_started', workerId: options.workerId }))
      await Promise.all([
        runSchedulerContinuously(dependencies, options, controller.signal),
        ...(anchorWorkflowConfig.enabled
          ? [runAnchorWorkflowContinuously({ repository: anchorCaseRepository, keyring: contactSecretKeyring }, anchorWorkflowConfig, options.workerId, controller.signal)]
          : []),
      ])
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
