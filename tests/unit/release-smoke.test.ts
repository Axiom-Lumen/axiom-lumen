import { describe, expect, it, vi } from 'vitest'
import { OPENAPI_EXAMPLES } from '../../lib/openapi/document'
import { parseReleaseManifest } from '../../lib/release/manifest'
import { runReleaseSmoke, type ReleaseSmokeInput } from '../../lib/release/smoke'

const digest = `sha256:${'a'.repeat(64)}`
const manifest = parseReleaseManifest({
  schema_version: 'axiom-release-v1',
  commit_sha: 'b'.repeat(40),
  image: `ghcr.io/axiom-lumen/axiom-lumen@${digest}`,
  image_digest: digest,
  source_repository: 'Axiom-Lumen/axiom-lumen',
  source_run_id: '12345',
  built_at: '2026-08-13T12:00:00.000Z',
  sbom_attested: true,
  provenance_attested: true,
  ci_passed: true,
})
const features = {
  supply: true,
  depth: true,
  trustlines: true,
  anchorReserves: true,
  namedPartyPublication: false,
}

function responseFor(path: string) {
  if (path === '/api/health/live') return Response.json({ release: { environment: 'staging', imageDigest: digest, commitSha: manifest.commit_sha }, features })
  if (path === '/api/health/ready') return Response.json({ status: 'ready' })
  if (path.startsWith('/api/v1/stellar/latest-ledger')) return Response.json(OPENAPI_EXAMPLES.latestVerified)
  if (path.startsWith('/api/v1/supply/')) return Response.json(OPENAPI_EXAMPLES.supplyVerified)
  if (path.startsWith('/api/v1/depth/')) return Response.json(OPENAPI_EXAMPLES.depthVerified)
  if (path.startsWith('/api/v1/trustlines/')) return Response.json(OPENAPI_EXAMPLES.trustlineVerified)
  if (path.startsWith('/api/v1/anchors/')) return Response.json(OPENAPI_EXAMPLES.anchorReserves)
  return Response.json({ error: 'unexpected path' }, { status: 500 })
}

function input(fetchClient: NonNullable<ReleaseSmokeInput['fetchClient']>): ReleaseSmokeInput {
  return {
    baseUrl: new URL('https://staging.axiom.example'),
    manifest,
    environment: 'staging',
    features,
    apiKey: 'smoke-key',
    asset: `USDC:G${'A'.repeat(55)}`,
    pair: `native~USDC:G${'A'.repeat(55)}`,
    anchor: 'anchor-a',
    workerProgressAfter: new Date('2026-08-10T11:59:59.000Z'),
    fetchClient,
  }
}

describe('release smoke checks', () => {
  it('requires successful contract-valid representative reads', async () => {
    const fetchClient = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-Axiom-Key')).toBe('smoke-key')
      return responseFor(new URL(request instanceof Request ? request.url : request).pathname)
    })
    await expect(runReleaseSmoke(input(fetchClient))).resolves.toEqual({ status: 'passed', image_digest: digest })
    expect(fetchClient).toHaveBeenCalledTimes(7)
  })

  it.each([401, 403, 404, 429])('rejects an enabled representative read returning %s', async (status) => {
    const fetchClient = vi.fn(async (request: string | URL | Request) => {
      const path = new URL(request instanceof Request ? request.url : request).pathname
      if (path.startsWith('/api/v1/supply/')) return Response.json({ error: { code: 'request_failed' } }, { status })
      return responseFor(path)
    })
    await expect(runReleaseSmoke(input(fetchClient))).rejects.toThrow(/did not return a successful representative read/)
  })

  it('rejects a successful response with the wrong contract', async () => {
    const fetchClient = vi.fn(async (request: string | URL | Request) => {
      const path = new URL(request instanceof Request ? request.url : request).pathname
      if (path.startsWith('/api/v1/depth/')) return Response.json({ status: 'looks-healthy' })
      return responseFor(path)
    })
    await expect(runReleaseSmoke(input(fetchClient))).rejects.toThrow(/invalid response contract/)
  })

  it('rejects a successful response containing malformed JSON', async () => {
    const fetchClient = vi.fn(async (request: string | URL | Request) => {
      const path = new URL(request instanceof Request ? request.url : request).pathname
      if (path.startsWith('/api/v1/trustlines/')) {
        return new Response('{not-json', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return responseFor(path)
    })
    await expect(runReleaseSmoke(input(fetchClient))).rejects.toThrow()
  })

  it('accepts only the exact fail-closed contract for a disabled metric', async () => {
    const disabledFeatures = { ...features, supply: false }
    const fetchClient = vi.fn(async (request: string | URL | Request) => {
      const path = new URL(request instanceof Request ? request.url : request).pathname
      if (path === '/api/health/live') return Response.json({ release: { environment: 'staging', imageDigest: digest, commitSha: manifest.commit_sha }, features: disabledFeatures })
      if (path.startsWith('/api/v1/supply/')) {
        return Response.json({
          error: { code: 'feature_not_available', message: 'This capability is not available in the current environment' },
          request_id: 'smoke-disabled',
          as_of: '2026-08-13T12:00:00.000Z',
          api_version: 'v1',
        }, { status: 404 })
      }
      return responseFor(path)
    })
    await expect(runReleaseSmoke({ ...input(fetchClient), features: disabledFeatures })).resolves.toMatchObject({ status: 'passed' })
  })

  it('rejects a worker that does not finalize a cycle after its rollout', async () => {
    const fetchClient = vi.fn(async (request: string | URL | Request) => responseFor(new URL(request instanceof Request ? request.url : request).pathname))
    await expect(runReleaseSmoke({
      ...input(fetchClient),
      workerProgressAfter: new Date('2026-08-10T12:00:01.000Z'),
      workerProgressTimeoutMs: 0,
      sleep: vi.fn(),
    })).rejects.toThrow(/worker did not finalize a latest-ledger cycle after rollout/)
  })

  it('waits until the replacement worker persists a newer cycle', async () => {
    let latestRequests = 0
    const sleep = vi.fn(async () => undefined)
    const fetchClient = vi.fn(async (request: string | URL | Request) => {
      const path = new URL(request instanceof Request ? request.url : request).pathname
      if (path === '/api/v1/stellar/latest-ledger' && latestRequests++ === 0) {
        return Response.json(OPENAPI_EXAMPLES.latestVerified)
      }
      if (path === '/api/v1/stellar/latest-ledger') {
        return Response.json({ ...OPENAPI_EXAMPLES.latestVerified, as_of: '2026-08-10T12:01:00.000Z' })
      }
      return responseFor(path)
    })
    await expect(runReleaseSmoke({
      ...input(fetchClient),
      workerProgressAfter: new Date('2026-08-10T12:00:30.000Z'),
      pollIntervalMs: 1,
      sleep,
    })).resolves.toMatchObject({ status: 'passed' })
    expect(sleep).toHaveBeenCalledOnce()
    expect(latestRequests).toBe(2)
  })

  it('retries a bounded empty-environment response while the worker starts', async () => {
    let latestRequests = 0
    const sleep = vi.fn(async () => undefined)
    const fetchClient = vi.fn(async (request: string | URL | Request) => {
      const path = new URL(request instanceof Request ? request.url : request).pathname
      if (path === '/api/v1/stellar/latest-ledger' && latestRequests++ === 0) {
        return Response.json({ error: { code: 'snapshot_not_found' } }, { status: 404 })
      }
      if (path === '/api/v1/stellar/latest-ledger') {
        return Response.json({ ...OPENAPI_EXAMPLES.latestVerified, as_of: '2026-08-10T12:01:00.000Z' })
      }
      return responseFor(path)
    })
    await expect(runReleaseSmoke({
      ...input(fetchClient),
      workerProgressAfter: new Date('2026-08-10T12:00:30.000Z'),
      pollIntervalMs: 1,
      sleep,
    })).resolves.toMatchObject({ status: 'passed' })
    expect(sleep).toHaveBeenCalledOnce()
  })
})
