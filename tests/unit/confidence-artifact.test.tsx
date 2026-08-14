import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  ConfidenceArtifactView,
  ConfidenceJson,
  ConfidenceJsonLoading,
} from '../../components/confidence-json'
import { apiReconciliationSnapshotSchema } from '../../lib/contracts'
import {
  DEFAULT_ASSET,
  createIllustrativeSupplyArtifact,
  loadConfidenceArtifact,
  resolveConfidenceAsset,
} from '../../lib/home/confidence-artifact'
import { createOpenApiDocument } from '../../lib/openapi/document'
import { issueApiKey } from '../../lib/api-access/key'
import { loadFirstPartyConfidenceArtifact, resolveSiteApiAccess } from '../../lib/home/site-confidence-artifact'

const AS_OF = '2026-08-10T12:00:00.000Z'

function availableSnapshot(status: 'verified' | 'degraded') {
  return apiReconciliationSnapshotSchema.parse({
    ...createIllustrativeSupplyArtifact(),
    status,
    value: { kind: 'amount', value: '1000' },
    confidence: status === 'verified' ? 0.95 : 0.6,
    sources_configured: 2,
    sources_responded: 2,
    sources_usable: 2,
    sources_agreeing: status === 'verified' ? 2 : 1,
  })
}

function errorResponse(code: string) {
  return {
    error: { code, message: 'A test response' },
    request_id: 'artifact_test',
    as_of: AS_OF,
    api_version: 'v1',
  }
}

function jsonResponse(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fetchReturning(response: Response) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response)
}

describe('confidence artifact data source', () => {
  it('uses a canonical Public Network USDC default and rejects invalid overrides', () => {
    expect(resolveConfidenceAsset()).toBe(DEFAULT_ASSET)
    expect(() => resolveConfidenceAsset('USDC')).toThrow()
    expect(() => resolveConfidenceAsset('native')).toThrow()
  })

  it.each(['verified', 'degraded'] as const)('accepts a validated %s response as live', async (status) => {
    const fetcher = fetchReturning(jsonResponse(availableSnapshot(status), 200))
    const state = await loadConfidenceArtifact({
      fetcher: fetcher as unknown as typeof fetch,
      appUrl: 'https://axiom.example',
    })

    expect(state).toMatchObject({ kind: status, asset: DEFAULT_ASSET })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe(`https://axiom.example/api/v1/supply/${encodeURIComponent(DEFAULT_ASSET)}`)
    expect(init).toMatchObject({ cache: 'no-store', headers: { Accept: 'application/json' } })
  })

  it('adds a site API key only when explicitly supplied by the server caller', async () => {
    const fetcher = fetchReturning(jsonResponse(availableSnapshot('verified'), 200))
    await loadConfidenceArtifact({ fetcher: fetcher as unknown as typeof fetch, appUrl: 'https://axiom.example', apiKey: 'server-secret' })
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ Accept: 'application/json', 'X-Axiom-Key': 'server-secret' })
  })

  it('requires a valid server-only site key and forwards it for every first-party loader', async () => {
    const siteKey = issueApiKey().key
    expect(() => resolveSiteApiAccess({ NODE_ENV: 'production', AXIOM_API_AUTH_REQUIRED: 'true' })).toThrow(/AXIOM_SITE_API_KEY/)
    const load = vi.fn(async () => ({ kind: 'empty' as const, asset: DEFAULT_ASSET }))
    await expect(loadFirstPartyConfidenceArtifact(load, {
      NODE_ENV: 'production', AXIOM_API_AUTH_REQUIRED: 'true', AXIOM_SITE_API_KEY: siteKey,
    })).resolves.toMatchObject({ refreshEnabled: false, state: { kind: 'empty' } })
    expect(load).toHaveBeenCalledWith({ apiKey: siteKey })
  })

  it('distinguishes stale and currently unavailable 503 snapshots', async () => {
    const stale = apiReconciliationSnapshotSchema.parse({
      ...createIllustrativeSupplyArtifact(),
      confidence_caps_applied: ['snapshot_stale'],
    })
    await expect(loadConfidenceArtifact({
      fetcher: fetchReturning(jsonResponse(stale, 503)) as unknown as typeof fetch,
      appUrl: 'https://axiom.example',
    })).resolves.toMatchObject({ kind: 'stale', snapshot: stale })

    const unavailable = createIllustrativeSupplyArtifact()
    await expect(loadConfidenceArtifact({
      fetcher: fetchReturning(jsonResponse(unavailable, 503)) as unknown as typeof fetch,
      appUrl: 'https://axiom.example',
    })).resolves.toMatchObject({ kind: 'unavailable', response: unavailable })

    await expect(loadConfidenceArtifact({
      fetcher: fetchReturning(jsonResponse(errorResponse('supply_read_unavailable'), 503)) as unknown as typeof fetch,
      appUrl: 'https://axiom.example',
    })).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('distinguishes an empty endpoint from malformed, failed, and unexpected responses', async () => {
    await expect(loadConfidenceArtifact({
      fetcher: fetchReturning(jsonResponse(errorResponse('supply_snapshot_not_found'), 404)) as unknown as typeof fetch,
      appUrl: 'https://axiom.example',
    })).resolves.toMatchObject({ kind: 'empty' })

    await expect(loadConfidenceArtifact({
      fetcher: fetchReturning(jsonResponse({ status: 'verified' }, 200)) as unknown as typeof fetch,
      appUrl: 'https://axiom.example',
    })).resolves.toMatchObject({ kind: 'error', reason: 'invalid_response' })

    await expect(loadConfidenceArtifact({
      fetcher: vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch,
      appUrl: 'https://axiom.example',
    })).resolves.toMatchObject({ kind: 'error', reason: 'request_failed' })

    await expect(loadConfidenceArtifact({
      fetcher: fetchReturning(jsonResponse(errorResponse('teapot'), 418)) as unknown as typeof fetch,
      appUrl: 'https://axiom.example',
    })).resolves.toMatchObject({ kind: 'error', reason: 'unexpected_status' })
  })

  it('keeps the illustrative fallback keys aligned with the OpenAPI response contract', () => {
    const exampleKeys = Object.keys(createIllustrativeSupplyArtifact()).sort()
    const schema = createOpenApiDocument().components.schemas.ReconciliationSnapshot as { required: string[] }

    expect(exampleKeys).toEqual([...schema.required].sort())
    expect(exampleKeys).toMatchInlineSnapshot(`
      [
        "api_version",
        "as_of",
        "confidence",
        "confidence_caps_applied",
        "confidence_components",
        "confidence_formula_version",
        "contributions",
        "discrepancies",
        "methodology_version",
        "metric",
        "request_id",
        "source_errors",
        "sources_agreeing",
        "sources_configured",
        "sources_excluded",
        "sources_responded",
        "sources_usable",
        "status",
        "subject",
        "value",
      ]
    `)
  })

  it('renders textual state labels and response-derived JSON keys', () => {
    const verified = availableSnapshot('verified')
    const liveMarkup = renderToStaticMarkup(
      <ConfidenceArtifactView state={{ kind: 'verified', asset: DEFAULT_ASSET, snapshot: verified }} />,
    )
    expect(liveMarkup).toContain('Live verified supply snapshot')
    expect(liveMarkup).toContain('data-artifact-state="live"')
    expect(liveMarkup).toContain('role="status"')
    expect(liveMarkup).toContain('aria-live="polite"')
    expect(liveMarkup).toContain('aria-atomic="true"')
    for (const key of Object.keys(verified)) expect(liveMarkup).toContain(key)

    expect(renderToStaticMarkup(<ConfidenceJsonLoading />)).toContain('Loading live supply snapshot')
    expect(renderToStaticMarkup(
      <ConfidenceArtifactView state={{ kind: 'empty', asset: DEFAULT_ASSET }} />,
    )).toContain('Illustrative example — no live snapshot')

    const degradedMarkup = renderToStaticMarkup(
      <ConfidenceArtifactView state={{
        kind: 'degraded',
        asset: DEFAULT_ASSET,
        snapshot: availableSnapshot('degraded'),
      }} />,
    )
    expect(degradedMarkup).toContain('Live degraded supply snapshot')

    const unavailable = createIllustrativeSupplyArtifact()
    expect(renderToStaticMarkup(
      <ConfidenceArtifactView state={{ kind: 'stale', asset: DEFAULT_ASSET, snapshot: unavailable }} />,
    )).toContain('Stale supply snapshot — not current')
    expect(renderToStaticMarkup(
      <ConfidenceArtifactView state={{ kind: 'unavailable', asset: DEFAULT_ASSET, response: unavailable }} />,
    )).toContain('Current supply endpoint state — unavailable')
    expect(renderToStaticMarkup(
      <ConfidenceArtifactView state={{ kind: 'error', asset: DEFAULT_ASSET, reason: 'request_failed' }} />,
    )).toContain('Illustrative example — live response unavailable')
  })

  it('renders the Suspense loading state while the supply request is unresolved', () => {
    const load = vi.fn(() => new Promise<Awaited<ReturnType<typeof loadConfidenceArtifact>>>(() => undefined))
    const markup = renderToStaticMarkup(<ConfidenceJson load={load} />)

    expect(markup).toContain('Loading live supply snapshot')
    expect(markup).not.toContain('Live verified supply snapshot')
    expect(load).toHaveBeenCalledOnce()
  })

  it('keeps artifact output responsive and free of artificial focus stops', () => {
    const markup = renderToStaticMarkup(
      <ConfidenceArtifactView state={{
        kind: 'verified',
        asset: DEFAULT_ASSET,
        snapshot: availableSnapshot('verified'),
      }} />,
    )

    expect(markup).toContain('overflow-x-auto')
    expect(markup).toContain('sm:p-6')
    expect(markup).not.toMatch(/<(?:a|button|input|select|textarea)\b/i)
    expect(markup).not.toContain('tabindex=')
  })

  it('uses the shared confidence artifact on every required route', () => {
    for (const page of ['app/page.tsx', 'app/docs/page.tsx', 'app/methodology/page.tsx']) {
      const source = readFileSync(resolve(process.cwd(), page), 'utf8')
      expect(source.match(/<ConfidenceJson\s*\/>/g), page).toHaveLength(1)
    }
  })
})
