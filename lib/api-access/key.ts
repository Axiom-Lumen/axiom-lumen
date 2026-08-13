import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const API_KEY_PREFIX = 'axl_live_'
const KEY_ID_BYTES = 9
const KEY_SECRET_BYTES = 32
const apiKeySchema = z.string().regex(/^axl_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/)

export interface IssuedApiKey {
  key: string
  keyPrefix: string
  keyHash: string
}

export function apiAuthenticationRequired(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const value = environment.AXIOM_API_AUTH_REQUIRED
  if (value === undefined) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('AXIOM_API_AUTH_REQUIRED must be explicitly configured in production')
    }
    return false
  }
  if (value === 'false') return false
  if (value === 'true') return true
  throw new Error('AXIOM_API_AUTH_REQUIRED must be true or false')
}

export function hashApiKey(key: string) {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

export function issueApiKey(random: (size: number) => Buffer = randomBytes): IssuedApiKey {
  const keyPrefix = random(KEY_ID_BYTES).toString('base64url')
  const secret = random(KEY_SECRET_BYTES).toString('base64url')
  const key = `${API_KEY_PREFIX}${keyPrefix}_${secret}`
  return { key, keyPrefix, keyHash: hashApiKey(key) }
}

export function parseApiKey(value: string | null) {
  if (!value) return null
  const parsed = apiKeySchema.safeParse(value)
  if (!parsed.success) return null
  return { key: parsed.data, keyPrefix: parsed.data.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + 12) }
}

export function apiKeyHashMatches(key: string, expectedHex: string) {
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false
  return timingSafeEqual(Buffer.from(hashApiKey(key), 'hex'), Buffer.from(expectedHex, 'hex'))
}
