import { IMPLEMENTED_PUBLIC_OPERATIONS } from '../openapi/document'

export const RELEASE_SMOKE_GET_PATHS = [
  '/api/health/live',
  '/api/health/ready',
  '/api/v1/stellar/latest-ledger',
  '/api/v1/supply/{asset}',
  '/api/v1/depth/{pair}',
  '/api/v1/trustlines/{asset}',
  '/api/v1/anchors/{anchor}/reserves',
  '/api/v1/events/snapshots',
  '/status',
] as const

export const PUBLIC_CLAIM_SURFACES = [
  'README.md',
  'CONTRIBUTING.md',
  'app/pricing/page.tsx',
  'app/docs/page.tsx',
  'app/page.tsx',
  'app/dashboard/page.tsx',
  'lib/home/data.ts',
  'components/ui/home/hero.tsx',
  'components/nav.tsx',
  'docs/implementation-roadmap.md',
] as const

export const FORBIDDEN_PUBLIC_CLAIM_PATTERNS: { id: string, pattern: RegExp, surfaces?: readonly string[] }[] = [
  { id: 'paid_plan_price', pattern: /\$\d+/, surfaces: ['app/pricing/page.tsx', 'components/ui/home/hero.tsx'] },
  { id: 'commercial_uptime_sla', pattern: /99\.9%/, surfaces: ['app/pricing/page.tsx'] },
  { id: 'cardless_checkout', pattern: /no card required/i, surfaces: ['app/pricing/page.tsx'] },
  { id: 'stale_horizon_env_urls', pattern: /STELLAR_HORIZON_URLS/, surfaces: ['app/docs/page.tsx'] },
  { id: 'noncanonical_v1_prefix', pattern: /path: '\/v1\//, surfaces: ['app/docs/page.tsx'] },
  { id: 'confidence_as_probability', pattern: /probabilistic ground truth/i, surfaces: ['lib/home/data.ts'] },
  { id: 'public_v1_ga', pattern: /public v1 is (live|available|released|generally available)/i },
]

export function implementedPublicGetPaths() {
  return [...new Set(
    IMPLEMENTED_PUBLIC_OPERATIONS
      .filter((operation) => operation.method === 'get')
      .map((operation) => operation.path),
  )]
}

export function undocumentedSmokeGaps() {
  return implementedPublicGetPaths().filter((path) => !(RELEASE_SMOKE_GET_PATHS as readonly string[]).includes(path))
}
