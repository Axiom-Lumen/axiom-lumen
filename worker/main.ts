import { createDatabaseClient } from '../lib/db/client'
import { createPersistenceRepositories } from '../lib/db/repositories'
import { createAnchorCaseRepository } from '../lib/db/anchor-case-repository'
import { createSchedulerRepository } from '../lib/db/scheduler-repository'
import { LATEST_LEDGER_METHODOLOGY_VERSION } from '../lib/reconcile/latest-ledger'
import { ANCHOR_RESERVE_METHODOLOGY_VERSION, DEPTH_RECONCILIATION_METHODOLOGY_VERSION, SUPPLY_METHODOLOGY_VERSION, TRUSTLINE_METHODOLOGY_VERSION } from '../config/methodology'
import { parseHorizonHostList } from '../lib/stellar/horizon'
import { parseAnchorWorkflowConfig, parseSourceResilienceConfig, parseWorkerConfig } from '../lib/worker/config'
import { parseContactSecretKeyring } from '../lib/anchor/contact-secret'
import { createLatestLedgerJobHandler } from '../lib/worker/latest-ledger-job'
import { createSupplyJobHandler } from '../lib/worker/supply-job'
import { createDepthJobHandler } from '../lib/worker/depth-job'
import { createTrustlineJobHandler } from '../lib/worker/trustline-job'
import { createAnchorReserveJobHandler } from '../lib/worker/anchor-reserve-job'
import { runSchedulerContinuously, runSchedulerOnce } from '../lib/worker/scheduler'
import { runAnchorWorkflowContinuously, runAnchorWorkflowOnce } from '../lib/worker/anchor-case-workflow'
import { errorTelemetry, structuredLog } from '../lib/observability/telemetry'
import { parseReleaseFeatureFlags, parseReleaseMetadata } from '../lib/release/config'

function executionMode(arguments_: readonly string[]) {
  const once = arguments_.includes('--once')
  const continuous = arguments_.includes('--continuous')
  if (once === continuous) throw new Error('Specify exactly one of --once or --continuous')
  return once ? 'once' : 'continuous'
}

async function main() {
  const mode = executionMode(process.argv.slice(2))
  const features = parseReleaseFeatureFlags()
  const release = parseReleaseMetadata()
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
      supplyMethodologyVersion: features.supply ? SUPPLY_METHODOLOGY_VERSION : undefined,
      depthMethodologyVersion: features.depth ? DEPTH_RECONCILIATION_METHODOLOGY_VERSION : undefined,
      trustlineMethodologyVersion: features.trustlines ? TRUSTLINE_METHODOLOGY_VERSION : undefined,
      anchorReserveMethodologyVersion: features.anchorReserves ? ANCHOR_RESERVE_METHODOLOGY_VERSION : undefined,
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
      telemetry: structuredLog,
    }
    if (mode === 'once') {
      const summary = await runSchedulerOnce(dependencies, options, controller.signal)
      const anchorWorkflow = await runAnchorWorkflowOnce({ repository: anchorCaseRepository, keyring: contactSecretKeyring }, anchorWorkflowConfig, options.workerId, controller.signal)
      structuredLog('info', 'worker_poll_complete', { worker_id: options.workerId, ...summary, anchor_workflow: anchorWorkflow })
    } else {
      structuredLog('info', 'worker_started', { worker_id: options.workerId, release, features })
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
  structuredLog('error', 'worker_failed', errorTelemetry(error))
  process.exitCode = 1
})
