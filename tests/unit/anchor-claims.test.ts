import { describe, expect, it, vi } from 'vitest'
import {
  claimantTextSchema,
  hashOpaqueToken,
  issueOpaqueToken,
  prepareEvidenceLink,
  prepareEvidenceUpload,
  verifyDomainClaim,
  verifyWebhookContact,
} from '../../lib/anchor/claims'

describe('anchor claimant primitives', () => {
  it('issues opaque hashed tokens without retaining entropy in the hash', () => {
    const issued = issueOpaqueToken('al_claim_', () => new Uint8Array(32).fill(7))
    expect(issued.token).toMatch(/^al_claim_/)
    expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(issued.tokenHash).not.toContain(issued.token)
    expect(hashOpaqueToken(issued.token)).toBe(issued.tokenHash)
  })

  it('verifies exactly one provider challenge in the claimed domain stellar.toml', async () => {
    const token = issueOpaqueToken('al_claim_', () => new Uint8Array(32).fill(8)).token
    const connect = vi.fn(async () => new Response(`[[VERIFICATION]]\nprovider = "axiomlumen.io"\nclaim_token = "${token}"\n`, { headers: { 'content-type': 'text/plain' } }))
    await expect(verifyDomainClaim({ domain: 'anchor.example', token, resolve: async () => ['93.184.216.34'], connectImpl: connect })).resolves.toMatchObject({ url: 'https://anchor.example/.well-known/stellar.toml' })
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('normalizes claimant text and rejects active control characters', () => {
    expect(claimantTextSchema.parse('  measured explanation  ')).toBe('measured explanation')
    expect(() => claimantTextSchema.parse('invalid\u0000text')).toThrow(/control/)
  })

  it('scans uploads before storage and rejects malware and oversized input', async () => {
    const order: string[] = []
    const clean = await prepareEvidenceUpload({
      bytes: new TextEncoder().encode('evidence'),
      contentType: 'text/plain',
      scanner: { scan: async () => { order.push('scan'); return { clean: true, engine: 'fixture' } } },
      storage: { put: async () => { order.push('store'); return 'evidence/sha256/object' } },
      clock: () => new Date('2026-08-12T10:00:00.000Z'),
    })
    expect(order).toEqual(['scan', 'store'])
    expect(clean).toMatchObject({ kind: 'upload', scanStatus: 'clean', byteSize: 8 })
    await expect(prepareEvidenceUpload({
      bytes: new Uint8Array([1]), contentType: 'application/pdf',
      scanner: { scan: async () => ({ clean: false, engine: 'fixture', signature: 'test-malware' }) },
      storage: { put: vi.fn() },
    })).rejects.toThrow(/malware scanning/)
    await expect(prepareEvidenceUpload({
      bytes: new Uint8Array(5_000_001), contentType: 'application/pdf',
      scanner: { scan: vi.fn() }, storage: { put: vi.fn() },
    })).rejects.toThrow(/1 through 5000000 bytes/)
  })

  it('accepts only public HTTPS evidence links', async () => {
    await expect(prepareEvidenceLink({ kind: 'link', url: 'https://evidence.example/report' }, async () => ['93.184.216.34']))
      .resolves.toEqual({ kind: 'link', url: 'https://evidence.example/report', scanStatus: 'not_required' })
    await expect(prepareEvidenceLink({ kind: 'link', url: 'http://evidence.example/report' })).rejects.toThrow(/HTTPS/)
  })

  it('requires a bounded same-domain webhook challenge echo', async () => {
    const connect = vi.fn(async () => new Response(JSON.stringify({ challenge: 'proof' }), { headers: { 'content-type': 'application/json' } }))
    await expect(verifyWebhookContact({
      url: 'https://anchor.example/hooks/axiom', expectedHostname: 'anchor.example', challenge: 'proof',
      resolve: async () => ['93.184.216.34'], connectImpl: connect,
    })).resolves.toEqual({ url: 'https://anchor.example/hooks/axiom' })
    const wrong = vi.fn(async () => new Response(JSON.stringify({ challenge: 'wrong' }), { headers: { 'content-type': 'application/json' } }))
    await expect(verifyWebhookContact({
      url: 'https://anchor.example/hooks/axiom', expectedHostname: 'anchor.example', challenge: 'proof',
      resolve: async () => ['93.184.216.34'], connectImpl: wrong,
    })).rejects.toThrow(/did not echo/)
  })
})
