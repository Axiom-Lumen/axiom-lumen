import { describe, expect, it, vi } from 'vitest'
import { encryptContactSecret, parseContactSecretKeyring } from '../../lib/anchor/contact-secret'
import type { AnchorCaseRepository } from '../../lib/db/anchor-case-repository'
import { runAnchorWorkflowOnce } from '../../lib/worker/anchor-case-workflow'
import type { AnchorWorkflowConfig } from '../../lib/worker/config'

const config: AnchorWorkflowConfig = {
  enabled: true,
  concurrency: 2,
  claimLimit: 10,
  leaseDurationMs: 30_000,
  pollIntervalMs: 5_000,
  maximumAttempts: 3,
  retryBaseDelayMs: 1_000,
  retryMaximumDelayMs: 10_000,
  transportTimeoutMs: 5_000,
  maximumResponseBytes: 1_000,
}

describe('anchor case workflow worker', () => {
  it('opens candidates, decrypts webhook secrets, schedules retries, and expires due cases', async () => {
    const keyring = parseContactSecretKeyring({
      ANCHOR_CONTACT_SECRET_KEYS: `key-1:${Buffer.alloc(32, 5).toString('base64')}`,
      ANCHOR_CONTACT_ACTIVE_KEY_ID: 'key-1',
    })
    const encrypted = encryptContactSecret({
      secret: 'signing-secret',
      contactEndpointId: 'contact-1',
      version: 1,
      keyring,
      random: () => new Uint8Array(12).fill(9),
    })
    const recordDeliveryAttempt = vi.fn(async () => ({ status: 'failed' as const, attemptId: 'attempt-1', caseId: 'case-1' }))
    const repository = {
      findEligibleCaseCandidates: vi.fn(async () => [{ discrepancyId: 'disc-1', triggeringEventId: 'event-1' }]),
      openEligibleCase: vi.fn(async () => ({ status: 'opened' as const, caseId: 'case-1', notificationIds: ['notice-1'] })),
      claimDueNotifications: vi.fn(async () => [{
        id: 'notice-1',
        contactEndpointId: 'contact-1',
        leaseToken: 2,
        attemptCount: 0,
        channel: 'webhook' as const,
        endpoint: 'https://hooks.example/notice',
        payload: { caseId: 'case-1' },
        secret: { version: 1, ...encrypted },
      }]),
      recordDeliveryAttempt,
      expireDueReplyWindows: vi.fn(async () => ['case-expired']),
    } as unknown as AnchorCaseRepository
    const transport = vi.fn(async (dispatch: { webhookSecret?: string }) => {
      expect(dispatch.webhookSecret).toBe('signing-secret')
      return {
        outcome: 'failed' as const,
        startedAt: '2026-08-12T10:00:00.000Z',
        completedAt: '2026-08-12T10:00:00.000Z',
        failure: { code: 'request_failed', retryable: true },
      }
    })

    const result = await runAnchorWorkflowOnce({
      repository,
      keyring,
      transport: transport as never,
      clock: () => new Date('2026-08-12T10:00:00.000Z'),
    }, config, 'worker-1')

    expect(result).toEqual({ enabled: true, casesOpened: 1, caseFailures: 0, claimed: 1, sent: 0, failed: 1, expired: 1 })
    expect(recordDeliveryAttempt).toHaveBeenCalledWith(expect.objectContaining({
      notificationId: 'notice-1',
      workerId: 'worker-1',
      leaseToken: 2,
      result: expect.objectContaining({ nextAttemptAt: '2026-08-12T10:00:01.000Z' }),
    }))
  })

  it('does no database work when the workflow is disabled', async () => {
    const repository = { findEligibleCaseCandidates: vi.fn() } as unknown as AnchorCaseRepository
    expect(await runAnchorWorkflowOnce({ repository }, { ...config, enabled: false }, 'worker-1')).toMatchObject({ enabled: false })
    expect(repository.findEligibleCaseCandidates).not.toHaveBeenCalled()
  })
})
