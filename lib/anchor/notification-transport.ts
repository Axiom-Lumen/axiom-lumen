import { createHmac, timingSafeEqual } from 'node:crypto'
import { canonicalEvidenceJson } from '../evidence/json'
import {
  fetchSafePublicHttps,
  readBoundedBytes,
  type ResolveHost,
  type SafeHttpsConnect,
} from '../stellar/safe-http'

export const WEBHOOK_SIGNATURE_VERSION = 'v1' as const

export interface NotificationDispatch {
  notificationId: string
  channel: 'email' | 'webhook'
  endpoint: string
  payload: Record<string, unknown>
  webhookSecret?: string
}

export interface NotificationTransportOptions {
  emailRelayUrl?: string
  emailRelayToken?: string
  timeoutMs: number
  maximumResponseBytes: number
  resolve?: ResolveHost
  connectImpl?: SafeHttpsConnect
  clock?: () => Date
}

export function signWebhookPayload(input: { payload: string; timestamp: string; secret: string }) {
  if (!input.secret) throw new Error('webhook signing secret is required')
  return createHmac('sha256', input.secret).update(`${input.timestamp}.${input.payload}`).digest('hex')
}

export function verifyWebhookSignature(input: { payload: string; timestamp: string; secret: string; signature: string }) {
  if (!/^[0-9a-f]{64}$/.test(input.signature)) return false
  const expected = Buffer.from(signWebhookPayload(input), 'hex')
  return timingSafeEqual(expected, Buffer.from(input.signature, 'hex'))
}

function deliveryFailure(error: unknown, completedAt: string) {
  const code = error instanceof DOMException && error.name === 'AbortError'
    ? 'request_aborted'
    : error instanceof Error && error.name === 'UnsafeEndpointError'
      ? 'unsafe_endpoint'
      : 'request_failed'
  return {
    outcome: 'failed' as const,
    completedAt,
    failure: { code, retryable: code === 'request_failed' || code === 'request_aborted' },
  }
}

/** Sends one bounded HTTPS notice without exposing endpoint secrets in its result. */
export async function dispatchAnchorNotification(
  dispatch: NotificationDispatch,
  options: NotificationTransportOptions,
  signal: AbortSignal = new AbortController().signal,
) {
  const clock = options.clock ?? (() => new Date())
  const startedAt = clock().toISOString()
  const controller = new AbortController()
  const combinedSignal = AbortSignal.any([signal, controller.signal])
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const noticeJson = canonicalEvidenceJson(dispatch.payload)
    const timestamp = clock().toISOString()
    let url: string
    let body: string
    const headers = new Headers({ 'content-type': 'application/json', 'user-agent': 'axiom-lumen-anchor-notice/0.1' })
    if (dispatch.channel === 'webhook') {
      if (!dispatch.webhookSecret) throw new Error('webhook contact has no active signing secret')
      url = dispatch.endpoint
      body = noticeJson
      headers.set('x-axiom-lumen-delivery', dispatch.notificationId)
      headers.set('x-axiom-lumen-timestamp', timestamp)
      headers.set('x-axiom-lumen-signature', `${WEBHOOK_SIGNATURE_VERSION}=${signWebhookPayload({ payload: body, timestamp, secret: dispatch.webhookSecret })}`)
    } else {
      if (!options.emailRelayUrl || !options.emailRelayToken) throw new Error('email relay is not configured')
      url = options.emailRelayUrl
      body = canonicalEvidenceJson({
        to: dispatch.endpoint,
        subject: `Axiom Lumen discrepancy notice ${String(dispatch.payload.caseId ?? '')}`,
        notice: dispatch.payload,
      })
      headers.set('authorization', `Bearer ${options.emailRelayToken}`)
      headers.set('idempotency-key', dispatch.notificationId)
    }
    const response = await fetchSafePublicHttps(url, {
      resolve: options.resolve,
      connectImpl: options.connectImpl,
      init: { method: 'POST', headers, body, signal: combinedSignal, redirect: 'error' },
    })
    const responseBody = await readBoundedBytes(response, options.maximumResponseBytes)
    const completedAt = clock().toISOString()
    if (response.status < 200 || response.status >= 300) {
      return {
        outcome: 'failed' as const,
        startedAt,
        completedAt,
        httpStatus: response.status,
        responseBody,
        failure: {
          code: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
            ? 'retryable_http_status'
            : 'permanent_http_status',
          retryable: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
        },
      }
    }
    return { outcome: 'sent' as const, startedAt, completedAt, httpStatus: response.status, responseBody }
  } catch (error) {
    return { startedAt, ...deliveryFailure(error, clock().toISOString()) }
  } finally {
    clearTimeout(timeout)
  }
}
