import { describe, expect, it } from 'vitest'
import {
  decryptContactSecret,
  encryptContactSecret,
  parseContactSecretKeyring,
} from '../../lib/anchor/contact-secret'

const key = Buffer.alloc(32, 7).toString('base64')

describe('anchor contact secret encryption', () => {
  it('round trips with authenticated contact and version context', () => {
    const keyring = parseContactSecretKeyring({
      ANCHOR_CONTACT_SECRET_KEYS: `key-1:${key}`,
      ANCHOR_CONTACT_ACTIVE_KEY_ID: 'key-1',
    })
    const encrypted = encryptContactSecret({
      secret: 'webhook-signing-secret',
      contactEndpointId: 'contact-1',
      version: 1,
      keyring,
      random: () => new Uint8Array(12).fill(3),
    })

    expect(encrypted).not.toEqual(expect.objectContaining({ secret: expect.anything() }))
    expect(decryptContactSecret({ ...encrypted, contactEndpointId: 'contact-1', version: 1, keyring })).toBe('webhook-signing-secret')
    expect(() => decryptContactSecret({ ...encrypted, contactEndpointId: 'contact-2', version: 1, keyring })).toThrow(/authentication failed/)
    expect(() => decryptContactSecret({ ...encrypted, contactEndpointId: 'contact-1', version: 2, keyring })).toThrow(/authentication failed/)
  })

  it('requires a canonical 32-byte active key', () => {
    expect(() => parseContactSecretKeyring({
      ANCHOR_CONTACT_SECRET_KEYS: 'key-1:not-base64',
      ANCHOR_CONTACT_ACTIVE_KEY_ID: 'key-1',
    })).toThrow(/32-byte/)
    expect(() => parseContactSecretKeyring({
      ANCHOR_CONTACT_SECRET_KEYS: `key-1:${key}`,
      ANCHOR_CONTACT_ACTIVE_KEY_ID: 'missing',
    })).toThrow(/not present/)
  })
})
