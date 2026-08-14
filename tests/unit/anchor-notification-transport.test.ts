import { describe, expect, it, vi } from 'vitest'
import {
  dispatchAnchorNotification,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../../lib/anchor/notification-transport'

function clock(...values: string[]) {
  let index = 0
  return () => new Date(values[Math.min(index++, values.length - 1)]!)
}

describe('anchor notification transport', () => {
  it('signs canonical webhook requests and retains no secret in the result', async () => {
    const connect = vi.fn(async (_target, init?: RequestInit) => new Response('accepted', { status: 202 }))
    const result = await dispatchAnchorNotification({
      notificationId: 'notice-1',
      channel: 'webhook',
      endpoint: 'https://hooks.example/axiom',
      payload: { caseId: 'case-1', severity: 'warning' },
      webhookSecret: 'signing-secret',
    }, {
      timeoutMs: 1_000,
      maximumResponseBytes: 100,
      resolve: async () => ['93.184.216.34'],
      connectImpl: connect,
      clock: clock('2026-08-12T10:00:00.000Z', '2026-08-12T10:00:01.000Z', '2026-08-12T10:00:02.000Z'),
    })

    expect(result).toMatchObject({ outcome: 'sent', httpStatus: 202 })
    expect(JSON.stringify(result)).not.toContain('signing-secret')
    const init = connect.mock.calls[0]?.[1]
    const headers = new Headers(init?.headers)
    const body = String(init?.body)
    const timestamp = headers.get('x-axiom-lumen-timestamp')!
    expect(headers.get('x-axiom-lumen-signature')).toBe(`v1=${signWebhookPayload({ payload: body, timestamp, secret: 'signing-secret' })}`)
    expect(verifyWebhookSignature({ payload: body, timestamp, secret: 'signing-secret', signature: headers.get('x-axiom-lumen-signature')!.slice(3) })).toBe(true)
  })

  it('uses an idempotency key for email relay and classifies permanent failures', async () => {
    const connect = vi.fn(async (_target: unknown, _init?: RequestInit) => new Response('rejected', { status: 400 }))
    const result = await dispatchAnchorNotification({
      notificationId: 'notice-2',
      channel: 'email',
      endpoint: 'ops@example.com',
      payload: { caseId: 'case-1' },
    }, {
      emailRelayUrl: 'https://mail.example/send',
      emailRelayToken: 'relay-secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 100,
      resolve: async () => ['93.184.216.34'],
      connectImpl: connect,
      clock: clock('2026-08-12T10:00:00.000Z', '2026-08-12T10:00:01.000Z', '2026-08-12T10:00:02.000Z'),
    })
    expect(result).toMatchObject({ outcome: 'failed', failure: { code: 'permanent_http_status', retryable: false } })
    const headers = new Headers(connect.mock.calls[0]?.[1]?.headers)
    expect(headers.get('idempotency-key')).toBe('notice-2')
    expect(JSON.stringify(result)).not.toContain('relay-secret')
  })
})
