import { describe, expect, it } from 'vitest'
import { apiAuthenticationRequired, apiKeyHashMatches, hashApiKey, issueApiKey, parseApiKey } from '../../lib/api-access/key'
import { PUBLIC_API_ACCESS_POLICIES, parsePublicApiAccessPolicy } from '../../lib/api-access/policy'

describe('public API keys', () => {
  it('issues a parseable opaque key and stores only its SHA-256 digest', () => {
    let call = 0
    const issued = issueApiKey((size) => Buffer.alloc(size, ++call))
    expect(issued.key).toMatch(/^axl_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/)
    expect(parseApiKey(issued.key)).toEqual({ key: issued.key, keyPrefix: issued.keyPrefix })
    expect(issued.keyHash).toBe(hashApiKey(issued.key))
    expect(issued.keyHash).not.toContain(issued.key)
    expect(apiKeyHashMatches(issued.key, issued.keyHash)).toBe(true)
    expect(apiKeyHashMatches(issued.key.replace(/.$/, 'A'), issued.keyHash)).toBe(false)
  })

  it('rejects malformed keys without exposing format details to callers', () => {
    expect(parseApiKey(null)).toBeNull()
    expect(parseApiKey('axl_live_short_secret')).toBeNull()
    expect(apiKeyHashMatches('anything', 'invalid')).toBe(false)
  })

  it('parses the explicit hosted authentication policy fail-closed', () => {
    expect(apiAuthenticationRequired({})).toBe(false)
    expect(() => apiAuthenticationRequired({ NODE_ENV: 'production' })).toThrow(/explicitly configured/)
    expect(apiAuthenticationRequired({ AXIOM_API_AUTH_REQUIRED: 'true' })).toBe(true)
    expect(apiAuthenticationRequired({ AXIOM_API_AUTH_REQUIRED: 'false' })).toBe(false)
    expect(() => apiAuthenticationRequired({ AXIOM_API_AUTH_REQUIRED: 'yes' })).toThrow(/must be true or false/)
  })

  it('defines validated stable route and scope identifiers for every public GET', () => {
    expect(Object.values(PUBLIC_API_ACCESS_POLICIES).map(parsePublicApiAccessPolicy)).toEqual([
      { routeId: 'stellar.latest-ledger', requiredScope: 'metrics:read' },
      { routeId: 'stellar.supply', requiredScope: 'metrics:read' },
      { routeId: 'stellar.depth', requiredScope: 'metrics:read' },
      { routeId: 'stellar.trustlines', requiredScope: 'metrics:read' },
      { routeId: 'anchors.reserves', requiredScope: 'anchors:read' },
    ])
    expect(() => parsePublicApiAccessPolicy({ routeId: '../supply', requiredScope: 'metrics:read' })).toThrow()
  })
})
