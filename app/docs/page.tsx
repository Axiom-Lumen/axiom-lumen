import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHero, DocSection, CodePanel, K, S } from '@/components/site'

export const metadata: Metadata = {
  title: 'API documentation',
  description:
    'Implemented and planned API surfaces for Axiom Lumen, including the current latest-ledger reconciliation endpoint.',
}

const plannedEndpoints = [
  {
    method: 'GET',
    path: '/v1/supply/{asset}',
    name: 'Circulating supply',
    desc: 'Planned: cross-verified circulating supply for Stellar assets with per-source readings.',
  },
  {
    method: 'GET',
    path: '/v1/depth/{pair}',
    name: 'DEX order book depth',
    desc: 'Planned: verified bid and ask depth at configurable price bands for a trading pair.',
  },
  {
    method: 'GET',
    path: '/v1/trustlines/{asset}',
    name: 'Trustline state',
    desc: 'Planned: trustline counts and authorization state reconciled between Horizon and archive sources.',
  },
  {
    method: 'GET',
    path: '/v1/anchors/{anchor}/reserves',
    name: 'Anchor reserve comparison',
    desc: 'Planned: anchor self-reported reserves compared against on-chain supply with active discrepancies.',
  },
]

export default function DocsPage() {
  return (
    <main>
      <PageHero
        docCode="AL-API-02 · API STATUS"
        kicker="Developer documentation"
        title="One implemented endpoint. A broader API still planned."
      >
        The current repository implements a local latest-ledger reconciliation endpoint for
        multiple Stellar Horizon sources. Authenticated hosted APIs, paid tiers, WebSocket streams,
        and asset-supply endpoints remain planned work.
      </PageHero>

      <DocSection num="01" label="Implemented" title="Latest ledger reconciliation." wide>
        <div className="grid items-start gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_460px]">
          <div className="max-w-[560px]">
            <p className="mb-4 text-[15px] leading-relaxed text-muted">
              Configure comma-separated Horizon endpoints with{' '}
              <code className="font-mono text-[13px] text-cyan">STELLAR_HORIZON_URLS</code>. The
              endpoint trims, validates endpoint format, deduplicates, and caps configured sources,
              then reports source availability separately from data discrepancies.
            </p>
            <p className="mb-4 text-[15px] leading-relaxed text-muted">
              All configured Horizon endpoints must serve the same Stellar network. Do not reconcile
              mainnet, testnet, futurenet, or local-network endpoints together.
            </p>
            <p className="mb-8 text-[15px] leading-relaxed text-muted">
              Current limitation: the route checks URL format and whether configured endpoints can
              return latest-ledger data, but it does not yet validate Horizon network passphrases.
              Planned: validate Horizon network passphrases before reconciliation.
            </p>
            <CodePanel label="Local request">
              <code>{'curl http://localhost:3000/api/v1/stellar/latest-ledger'}</code>
            </CodePanel>
          </div>
          <CodePanel label="Response shape">
            <code>
              {'{\n  '}
              <K>{'"metric"'}</K>
              {': '}
              <S>{'"latest_ledger"'}</S>
              {',\n  '}
              <K>{'"value"'}</K>
              {': 54891234,\n  '}
              <K>{'"status"'}</K>
              {': '}
              <S>{'"verified"'}</S>
              {',\n  '}
              <K>{'"confidence"'}</K>
              {': 0.97,\n  '}
              <K>{'"sources_configured"'}</K>
              {': 3,\n  '}
              <K>{'"sources_responded"'}</K>
              {': 3,\n  '}
              <K>{'"sources_usable"'}</K>
              {': 3,\n  '}
              <K>{'"sources_agreeing"'}</K>
              {': 3,\n  '}
              <K>{'"sources_excluded"'}</K>
              {': 0,\n  '}
              <K>{'"observations"'}</K>
              {': [],\n  '}
              <K>{'"discrepancies"'}</K>
              {': [],\n  '}
              <K>{'"source_errors"'}</K>
              {': [],\n  '}
              <K>{'"as_of"'}</K>
              {': '}
              <S>{'"2026-07-12T12:00:00.000Z"'}</S>
              {'\n}'}
            </code>
          </CodePanel>
        </div>
      </DocSection>

      <DocSection num="02" label="Semantics" title="Status, confidence, and source visibility.">
        <div className="flex max-w-[640px] flex-col gap-4 text-[15px] leading-relaxed text-muted">
          <p>
            <K>verified</K> means at least two usable Horizon sources agreed without source errors
            and confidence stayed high. <K>degraded</K> means a value is available but source
            availability, freshness, or agreement is limited. <K>unavailable</K> means no usable
            source could produce a latest-ledger value.
          </p>
          <p>
            <K>sources_configured</K> is the count of normalized endpoints accepted from configuration.
            <K>sources_responded</K> includes usable observations plus HTTP or application-level source
            errors, but not request failures or aborts. <K>sources_usable</K> is the count of valid
            observations used in reconciliation, and <K>sources_agreeing</K> is the count within one
            ledger of the reconciled value. <K>sources_excluded</K> counts endpoints rejected because
            their root metadata reported a different network passphrase than the first usable source.
          </p>
          <p>
            Request failures, non-200 responses, malformed payloads, empty records, and network
            mismatches appear in <K>source_errors</K>. Discrepancies are reserved for usable sources
            that responded with ledger data but disagreed with the reconciled value.
          </p>
        </div>
      </DocSection>

      <DocSection num="03" label="Planned" title="Target v1 API surfaces." wide>
        <div className="border-t-2 border-line">
          {plannedEndpoints.map((ep) => (
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
        <p className="mt-8 max-w-[620px] text-sm leading-relaxed text-muted">
          API keys, rate limits, paid tiers, SSE/WebSocket streams, persistent audit logs, and
          anchor right-of-reply tooling are not implemented in this repository yet. The broader
          methodology remains described on the{' '}
          <Link href="/methodology" className="text-gold underline-offset-4 hover:underline">
            methodology page
          </Link>
          .
        </p>
      </DocSection>
    </main>
  )
}
