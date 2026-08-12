import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface ContactSecretKeyring {
  activeKeyId: string
  keys: ReadonlyMap<string, Uint8Array>
}

export interface EncryptedContactSecret {
  keyId: string
  ciphertext: string
  initializationVector: string
  authenticationTag: string
}

function decodeKey(value: string) {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== 32 || bytes.toString('base64') !== value) {
    throw new Error('anchor contact encryption keys must be canonical base64-encoded 32-byte values')
  }
  return new Uint8Array(bytes)
}

/** Parses `key-id:base64,key-id-2:base64` without retaining the encoded source string. */
export function parseContactSecretKeyring(environment: Readonly<Record<string, string | undefined>> = process.env): ContactSecretKeyring {
  const encoded = environment.ANCHOR_CONTACT_SECRET_KEYS
  const activeKeyId = environment.ANCHOR_CONTACT_ACTIVE_KEY_ID?.trim()
  if (!encoded || !activeKeyId) throw new Error('ANCHOR_CONTACT_SECRET_KEYS and ANCHOR_CONTACT_ACTIVE_KEY_ID are required')
  const keys = new Map<string, Uint8Array>()
  for (const entry of encoded.split(',')) {
    const separator = entry.indexOf(':')
    const keyId = entry.slice(0, separator).trim()
    const value = entry.slice(separator + 1).trim()
    if (separator < 1 || !/^[a-zA-Z0-9._-]{1,64}$/.test(keyId) || keys.has(keyId)) {
      throw new Error('ANCHOR_CONTACT_SECRET_KEYS contains an invalid or duplicate key ID')
    }
    keys.set(keyId, decodeKey(value))
  }
  if (!keys.has(activeKeyId)) throw new Error('ANCHOR_CONTACT_ACTIVE_KEY_ID is not present in ANCHOR_CONTACT_SECRET_KEYS')
  return { activeKeyId, keys }
}

function aad(contactEndpointId: string, version: number) {
  return Buffer.from(`axiom-lumen:anchor-contact:${contactEndpointId}:v${version}`, 'utf8')
}

export function encryptContactSecret(input: {
  secret: string
  contactEndpointId: string
  version: number
  keyring: ContactSecretKeyring
  random?: (size: number) => Uint8Array
}): EncryptedContactSecret {
  if (!input.secret || input.secret.length > 4096) throw new Error('contact secret must contain between 1 and 4096 characters')
  if (!Number.isSafeInteger(input.version) || input.version <= 0) throw new Error('contact secret version must be positive')
  const key = input.keyring.keys.get(input.keyring.activeKeyId)
  if (!key) throw new Error('active contact encryption key is unavailable')
  const iv = Buffer.from((input.random ?? randomBytes)(12))
  if (iv.length !== 12) throw new Error('contact secret IV source must return 12 bytes')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(input.contactEndpointId, input.version))
  const ciphertext = Buffer.concat([cipher.update(input.secret, 'utf8'), cipher.final()])
  return {
    keyId: input.keyring.activeKeyId,
    ciphertext: ciphertext.toString('base64'),
    initializationVector: iv.toString('base64'),
    authenticationTag: cipher.getAuthTag().toString('base64'),
  }
}

export function decryptContactSecret(input: EncryptedContactSecret & {
  contactEndpointId: string
  version: number
  keyring: ContactSecretKeyring
}) {
  const key = input.keyring.keys.get(input.keyId)
  if (!key) throw new Error(`contact encryption key ${input.keyId} is unavailable`)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(input.initializationVector, 'base64'))
    decipher.setAAD(aad(input.contactEndpointId, input.version))
    decipher.setAuthTag(Buffer.from(input.authenticationTag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(input.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new Error('contact secret authentication failed')
  }
}
