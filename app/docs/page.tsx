import type { Metadata } from 'next'
import Link from 'next/link'
import {
  PageHero,
  DocSection,
  CodePanel,
  ConfidenceJson,
  ArrowLink,
  K,
  S,
} from '@/components/site'

export const metadata: Metadata = {
  title: 'API documentation',
  description:
    'Quickstart, endpoint reference, and response schema for the Axiom Lumen verification API — confidence-scored Stellar data over REST and WebSocket.',
}

const endpoints = [
  {
    method: 'GET',
    path: '/v1/supply/{asset}',
    name: 'Circulating supply',
    desc: 'Cross-verified circulating supply for any Stellar asset, with per-source readings.',
  },
  {
    method: 'GET',
    path: '/v1/depth/{pair}',
    name: 'DEX order book depth',
    desc: 'Verified bid and ask depth at configurable price bands for a trading pair.',
  },
  {
    method: 'GET',
    path: '/v1/trustlines/{asset}',
    name: 'Trustline state',
    desc: 'Trustline counts and authorization state, reconciled between Horizon and archive.',
  },
  {
    method: 'GET',
    path: '/v1/anchors/{anchor}/reserves',
    name: 'Anchor reserve comparison',
    desc: 'Anchor self-reported reserves compared against on-chain supply, with active discrepancies.',
  },
]

export default function DocsPage() {
  return (
    <main>
      <PageHero
        docCode="AL-API-02 · API VERSION V1"
        kicker="Developer documentation"
        title="One request. One verified answer."
      >
        The Axiom Lumen API returns confidence-scored Stellar data over REST, with WebSocket
        streams available on paid tiers. Everything below applies to API version v1.
      </PageHero>

      {/* 01 — Quickstart */}
      <DocSection
        num="01"
        label="Quickstart"
        title="Authenticate, request, read the confidence field."
        wide
      >
        <p className="mb-10 max-w-[620px] text-[15px] leading-relaxed text-muted">
          All requests are authenticated with an API key passed in the{' '}
          <code className="font-mono text-[13px] text-cyan">X-Axiom-Key</code> header. Keys are
          issued per project from the dashboard after you{' '}
          <Link href="/pricing" className="text-gold underline-offset-4 hover:underline">
            choose an access tier
          </Link>
          .
        </p>
        <div className="grid items-start gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_460px]">
          <div className="max-w-[520px]">
            <CodePanel label="First request">
              <code>
                {'curl https://api.axiomlumen.io/v1/supply/USDC:GA5Z... \\\n'}
                {'  -H '}
                <S>{'"X-Axiom-Key: al_live_..."'}</S>
              </code>
            </CodePanel>
            <p className="mt-6 text-sm leading-relaxed text-muted">
              Every response carries the same shape: the reconciled value, a confidence score
              between 0 and 1, the count of agreeing sources, and a full list of any active
              discrepancies. There is no &ldquo;simple&rdquo; response mode — the corroboration
              data is the product.
            </p>
          </div>
          <ConfidenceJson />
        </div>
      </DocSection>

      {/* 02 — Endpoint reference: ruled index, not cards */}
      <DocSection num="02" label="Endpoints" title="v1 endpoint reference." wide>
        <div className="border-t-2 border-line">
          {endpoints.map((ep) => (
            <div
              key={ep.path}
              className="grid gap-x-8 gap-y-2 border-b border-linesoft py-6 md:grid-cols-[56px_360px_minmax(0,1fr)]"
            >
              <div className="font-mono text-[11px] font-medium leading-6 text-gold">
                {ep.method}
              </div>
              <div>
                <div className="font-mono text-[13px] leading-6 text-cyan">{ep.path}</div>
                <div className="mt-1 font-serif text-[17px] font-medium">{ep.name}</div>
              </div>
              <p className="text-sm leading-relaxed text-muted md:pt-0.5">{ep.desc}</p>
            </div>
          ))}
        </div>
      </DocSection>

      {/* 03 — Confidence semantics */}
      <DocSection
        num="03"
        label="Response semantics"
        title="Confidence and discrepancies."
      >
        <div className="flex max-w-[620px] flex-col gap-4 text-[15px] leading-relaxed text-muted">
          <p>
            The <K>confidence</K> field measures how well the available sources corroborate one
            another — it is not a probability of correctness. The <K>discrepancies</K> array lists
            every source deviating beyond tolerance, with its delta and severity (<S>info</S>,{' '}
            <S>warning</S>, or <S>critical</S>). Discrepancy visibility depends on your access
            tier.
          </p>
          <p>
            The weighting, decay, and severity rules behind these fields are published in full in
            the{' '}
            <Link href="/methodology" className="text-gold underline-offset-4 hover:underline">
              methodology (v1.3)
            </Link>
            .
          </p>
        </div>
      </DocSection>

      {/* 04 — Rate limits */}
      <DocSection num="04" label="Rate limits" title="Limits scale with tier.">
        <p className="max-w-[620px] text-[15px] leading-relaxed text-muted">
          The Developer tier is free and rate-limited to 60 requests per minute over REST. Growth
          adds WebSocket streams and full discrepancy detail; Institutional adds custom limits and
          an SLA. Current limits are always returned in the{' '}
          <code className="font-mono text-[13px] text-cyan">X-RateLimit-*</code> response headers.
        </p>
        <div className="mt-10">
          <ArrowLink href="/pricing">Compare access tiers</ArrowLink>
        </div>
      </DocSection>
    </main>
  )
}
