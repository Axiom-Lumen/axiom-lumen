import type { ContactSecretKeyring } from '../anchor/contact-secret'
import { decryptContactSecret } from '../anchor/contact-secret'
import { dispatchAnchorNotification, type NotificationTransportOptions } from '../anchor/notification-transport'
import type { AnchorCaseRepository, NotificationDeliveryResult } from '../db/anchor-case-repository'
import type { AnchorWorkflowConfig } from './config'

export interface AnchorWorkflowDependencies {
  repository: AnchorCaseRepository
  keyring?: ContactSecretKeyring
  transport?: typeof dispatchAnchorNotification
  transportOptions?: Partial<NotificationTransportOptions>
  clock?: () => Date
}

function retryAt(now: string, attemptNumber: number, config: AnchorWorkflowConfig) {
  const delay = Math.min(config.retryMaximumDelayMs, config.retryBaseDelayMs * 2 ** Math.max(0, attemptNumber - 1))
  return new Date(Date.parse(now) + delay).toISOString()
}

function failedResult(at: string, code: string): NotificationDeliveryResult {
  return {
    outcome: 'failed',
    startedAt: at,
    completedAt: at,
    failure: { code, retryable: false },
  }
}

export async function runAnchorWorkflowOnce(
  dependencies: AnchorWorkflowDependencies,
  config: AnchorWorkflowConfig,
  workerId: string,
  signal: AbortSignal = new AbortController().signal,
) {
  if (!config.enabled) return { enabled: false as const, casesOpened: 0, caseFailures: 0, claimed: 0, sent: 0, failed: 0, expired: 0 }
  const clock = dependencies.clock ?? (() => new Date())
  const repository = dependencies.repository
  const now = clock().toISOString()
  let casesOpened = 0
  let caseFailures = 0
  const candidates = await repository.findEligibleCaseCandidates(config.claimLimit)
  for (const candidate of candidates) {
    try {
      const result = await repository.openEligibleCase({ ...candidate, openedAt: now })
      if (result.status === 'opened') casesOpened += 1
    } catch {
      caseFailures += 1
    }
  }
  const claimed = await repository.claimDueNotifications({
    workerId,
    now: clock().toISOString(),
    leaseDurationMs: config.leaseDurationMs,
    limit: config.claimLimit,
  })
  let sent = 0
  let failed = 0
  let cursor = 0
  async function consume() {
    while (!signal.aborted) {
      const claim = claimed[cursor++]
      if (!claim) return
      let result: NotificationDeliveryResult
      try {
        const webhookSecret = claim.channel === 'webhook' && claim.secret && dependencies.keyring
          ? decryptContactSecret({ ...claim.secret, contactEndpointId: claim.contactEndpointId, keyring: dependencies.keyring })
          : undefined
        const dispatch = dependencies.transport ?? dispatchAnchorNotification
        result = await dispatch({
          notificationId: claim.id,
          channel: claim.channel,
          endpoint: claim.endpoint,
          payload: claim.payload,
          ...(webhookSecret ? { webhookSecret } : {}),
        }, {
          timeoutMs: config.transportTimeoutMs,
          maximumResponseBytes: config.maximumResponseBytes,
          emailRelayUrl: config.emailRelayUrl,
          emailRelayToken: config.emailRelayToken,
          clock,
          ...dependencies.transportOptions,
        }, signal)
      } catch {
        result = failedResult(clock().toISOString(), 'secret_unavailable')
      }
      const attemptNumber = claim.attemptCount + 1
      if (result.outcome === 'failed' && result.failure?.retryable && attemptNumber < config.maximumAttempts) {
        result = { ...result, nextAttemptAt: retryAt(result.completedAt, attemptNumber, config) }
      }
      const recorded = await repository.recordDeliveryAttempt({
        notificationId: claim.id,
        workerId,
        leaseToken: claim.leaseToken,
        result,
      })
      if (recorded.status === 'sent') sent += 1
      else if (recorded.status === 'failed') failed += 1
    }
  }
  await Promise.all(Array.from({ length: config.concurrency }, () => consume()))
  const expired = await repository.expireDueReplyWindows({ now: clock().toISOString(), limit: config.claimLimit })
  return { enabled: true as const, casesOpened, caseFailures, claimed: claimed.length, sent, failed, expired: expired.length }
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => { clearTimeout(timeout); resolve() }, { once: true })
  })
}

export async function runAnchorWorkflowContinuously(
  dependencies: AnchorWorkflowDependencies,
  config: AnchorWorkflowConfig,
  workerId: string,
  signal: AbortSignal,
) {
  while (!signal.aborted) {
    await runAnchorWorkflowOnce(dependencies, config, workerId, signal)
    await delay(config.pollIntervalMs, signal)
  }
}
