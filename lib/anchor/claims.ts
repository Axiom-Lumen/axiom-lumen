import { createHash, randomBytes } from 'node:crypto'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import { assertSafePublicHttpsUrl, fetchSafePublicHttps, readBoundedText, type ResolveHost, type SafeHttpsConnect } from '../stellar/safe-http'

export const CLAIM_CHALLENGE_TTL_SECONDS = 30 * 60
export const CLAIM_SESSION_TTL_SECONDS = 24 * 60 * 60
export const CLAIM_VERIFICATION_TTL_SECONDS = 90 * 24 * 60 * 60
export const MAXIMUM_REPLY_CHARACTERS = 10_000
export const MAXIMUM_EVIDENCE_BYTES = 5_000_000

export const claimantTextSchema = z.string().trim().min(1).max(MAXIMUM_REPLY_CHARACTERS)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), 'text contains unsupported control characters')
  .transform((value) => value.normalize('NFC'))

const verificationTomlSchema = z.object({
  VERIFICATION: z.array(z.object({
    provider: z.string(),
    claim_token: z.string(),
  }).passthrough()).optional(),
}).passthrough()

const webhookChallengeResponseSchema = z.object({ challenge: z.string() }).strict()

export interface IssuedToken {
  token: string
  tokenHash: string
}

export function issueOpaqueToken(prefix: 'al_claim_' | 'al_session_', random: (size: number) => Uint8Array = randomBytes): IssuedToken {
  const entropy = Buffer.from(random(32))
  if (entropy.length !== 32) throw new Error('token entropy source must return 32 bytes')
  const token = `${prefix}${entropy.toString('base64url')}`
  return { token, tokenHash: hashOpaqueToken(token) }
}

export function hashOpaqueToken(token: string) {
  if (!/^al_(?:claim|session)_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('claim token has an invalid format')
  return createHash('sha256').update(token).digest('hex')
}

export async function verifyDomainClaim(input: {
  domain: string
  token: string
  resolve?: ResolveHost
  connectImpl?: SafeHttpsConnect
  timeoutMs?: number
  maximumBytes?: number
}) {
  const url = await assertSafePublicHttpsUrl(`https://${input.domain}/.well-known/stellar.toml`, {
    expectedHostname: input.domain,
    resolve: input.resolve,
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000)
  try {
    const response = await fetchSafePublicHttps(url, {
      expectedHostname: input.domain,
      resolve: input.resolve,
      connectImpl: input.connectImpl,
      init: { signal: controller.signal, redirect: 'error', headers: { accept: 'text/plain' } },
    })
    if (!response.ok || response.redirected) throw new Error('claim verification document could not be retrieved')
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'text/plain') throw new Error('claim verification document must use text/plain')
    const parsed = verificationTomlSchema.parse(parseToml(await readBoundedText(response, input.maximumBytes ?? 512_000)))
    const matches = (parsed.VERIFICATION ?? []).filter((entry) => entry.provider === 'axiomlumen.io' && entry.claim_token === input.token)
    if (matches.length !== 1) throw new Error('stellar.toml must contain exactly one matching Axiom Lumen claim token')
    return { url: url.toString(), verifiedAt: new Date().toISOString() }
  } finally {
    clearTimeout(timeout)
  }
}

/** Proves that a same-domain webhook is reachable and controlled before it is activated. */
export async function verifyWebhookContact(input: {
  url: string
  expectedHostname: string
  challenge: string
  resolve?: ResolveHost
  connectImpl?: SafeHttpsConnect
  timeoutMs?: number
  maximumBytes?: number
}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000)
  try {
    const response = await fetchSafePublicHttps(input.url, {
      expectedHostname: input.expectedHostname,
      resolve: input.resolve,
      connectImpl: input.connectImpl,
      init: {
        method: 'POST',
        signal: controller.signal,
        redirect: 'error',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ challenge: input.challenge }),
      },
    })
    if (!response.ok || response.redirected) throw new Error('webhook challenge could not be completed')
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') throw new Error('webhook challenge response must use application/json')
    const parsed = webhookChallengeResponseSchema.parse(JSON.parse(await readBoundedText(response, input.maximumBytes ?? 8_192)))
    if (parsed.challenge !== input.challenge) throw new Error('webhook challenge response did not echo the issued challenge')
    return { url: input.url }
  } finally {
    clearTimeout(timeout)
  }
}

export const evidenceLinkSchema = z.object({
  kind: z.literal('link'),
  url: z.string().url().max(2_048),
}).strict()

export interface PreparedEvidenceUpload {
  kind: 'upload'
  storageReference: string
  contentType: string
  byteSize: number
  sha256: string
  scanStatus: 'clean'
  scanResult: Record<string, unknown>
  scannedAt: string
}

export interface EvidenceScanner {
  scan(bytes: Uint8Array, contentType: string): Promise<{ clean: boolean; engine: string; signature?: string }>
}

export interface EvidenceStorage {
  put(input: { bytes: Uint8Array; contentType: string; sha256: string }): Promise<string>
}

export type EvidenceSubmission =
  | { kind: 'link'; url: string }
  | { kind: 'upload'; bytes: Uint8Array; contentType: string }

const ALLOWED_EVIDENCE_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'text/plain'])

/** Scans before durable storage; rejected bytes are never persisted by Axiom Lumen. */
export async function prepareEvidenceUpload(input: {
  bytes: Uint8Array
  contentType: string
  scanner: EvidenceScanner
  storage: EvidenceStorage
  clock?: () => Date
}): Promise<PreparedEvidenceUpload> {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > MAXIMUM_EVIDENCE_BYTES) {
    throw new Error(`evidence upload must contain 1 through ${MAXIMUM_EVIDENCE_BYTES} bytes`)
  }
  const contentType = input.contentType.toLowerCase().split(';', 1)[0]!.trim()
  if (!ALLOWED_EVIDENCE_TYPES.has(contentType)) throw new Error('evidence upload content type is not allowed')
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const scan = await input.scanner.scan(input.bytes, contentType)
  if (!scan.clean) throw new Error(`evidence upload was rejected by malware scanning${scan.signature ? ` (${scan.signature})` : ''}`)
  const storageReference = await input.storage.put({ bytes: input.bytes, contentType, sha256 })
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,511}$/.test(storageReference)) throw new Error('evidence storage returned an invalid opaque reference')
  return {
    kind: 'upload', storageReference, contentType, byteSize: input.bytes.byteLength, sha256,
    scanStatus: 'clean', scanResult: { engine: scan.engine },
    scannedAt: (input.clock ?? (() => new Date()))().toISOString(),
  }
}

/** Links are limited to public HTTPS and retained as references, never fetched during rendering. */
export async function prepareEvidenceLink(value: unknown, resolve?: ResolveHost) {
  const parsed = evidenceLinkSchema.parse(value)
  const url = await assertSafePublicHttpsUrl(parsed.url, { resolve })
  return { kind: 'link' as const, url: url.toString(), scanStatus: 'not_required' as const }
}
