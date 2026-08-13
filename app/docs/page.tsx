import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHero, DocSection, CodePanel, ConfidenceJson, K, S } from '@/components/site'

export const metadata: Metadata = {
  title: 'API documentation',
  description:
    'Implemented API surfaces for persisted metrics, reviewed anchor reserve disclosures, and live snapshot events.',
}

const anchorEndpoints = [
  {
    method: 'GET',
    path: '/v1/anchors/{anchor}/reserves',
    name: 'Anchor reserve comparison',
    desc: 'Reviewed public reserve disclosures; internal and pending named-party cases remain undisclosed.',
  },
]

export default function DocsPage() {
  return (
    <main>
      <PageHero
        docCode="AL-API-03 · API STATUS"
        kicker="Developer documentation"
        title="Six implemented endpoints. One machine-readable contract."
      >
        The current API serves persisted latest-ledger, supply, classic SDEX depth, trustline-state snapshots,
        and immutable reviewed anchor reserve comparisons.
        Hosted API-key enforcement, per-plan quotas, and resumable server-sent snapshot events are available;
        bidirectional WebSocket behavior and additional metrics remain planned work.
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
              Before reading ledgers, the connector checks each Horizon root endpoint&apos;s network
              passphrase. Sources on a different network are excluded and reported as source errors;
              they never contribute to the reconciled value or confidence.
            </p>
            <CodePanel label="Local request">
              <code>{'curl -H "X-Axiom-Key: $AXIOM_KEY" http://localhost:3000/api/v1/stellar/latest-ledger'}</code>
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

      <DocSection num="02" label="Supply" title="On-chain credit-asset supply." wide>
        <div className="grid items-start gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_460px]">
          <div className="max-w-[560px]">
            <p className="mb-4 text-[15px] leading-relaxed text-muted">
              Supply reads the latest finalized reconciliation snapshot from persistence. The
              canonical path parameter is a classic Stellar credit asset in{' '}
              <code className="font-mono text-[13px] text-cyan">CODE:ISSUER</code> form.
            </p>
            <p className="mb-8 text-[15px] leading-relaxed text-muted">
              The artifact shown here is fetched from the same endpoint and validated against the
              shared runtime response schema. Its label distinguishes verified, degraded, stale,
              unavailable, and illustrative fallback states.
            </p>
            <CodePanel label="Local request">
              <code>{'curl -H "X-Axiom-Key: $AXIOM_KEY" "http://localhost:3000/api/v1/supply/USDC:<issuer>"'}</code>
            </CodePanel>
          </div>
          <ConfidenceJson />
        </div>
      </DocSection>

      <DocSection num="03" label="Semantics" title="Status, confidence, and source visibility.">
        <div className="flex max-w-[640px] flex-col gap-4 text-[15px] leading-relaxed text-muted">
          <p>
            <K>verified</K> means the metric&apos;s minimum independent evidence requirement was met without source
            errors and confidence stayed high. Replicas of one derivation do not create independence. <K>degraded</K> means a value is available but source
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

      <DocSection num="04" label="Anchors" title="Publication-gated reserve disclosures." wide>
        <div className="border-t-2 border-line">
          {anchorEndpoints.map((ep) => (
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
          Each item retains the exact reviewed reserve and on-chain supply values, delta, evidence, and time
          boundary. The endpoint returns an empty collection for a verified anchor without publishable disclosures,
          so it does not reveal internal case existence. Hosted deployments can require API keys and enforce
          per-plan quotas; paid self-service remains planned. The broader methodology is described on the{' '}
          <Link href="/methodology" className="text-gold underline-offset-4 hover:underline">
            methodology page
          </Link>
          .
        </p>
      </DocSection>

      <DocSection num="05" label="Events" title="Resumable snapshot updates.">
        <div className="flex max-w-[680px] flex-col gap-4 text-[15px] leading-relaxed text-muted">
          <p>
            <K>GET /api/v1/events/snapshots</K> streams completed public-metric snapshot pointers as server-sent
            events. Persist the decimal event ID and reconnect with <K>Last-Event-ID</K> to replay without a
            silent gap. Connections without a cursor begin at the current live tail.
          </p>
          <CodePanel label="Streaming request">
            <code>{'curl -N -H "X-Axiom-Key: $AXIOM_KEY" -H "Last-Event-ID: 42" http://localhost:3000/api/v1/events/snapshots'}</code>
          </CodePanel>
        </div>
      </DocSection>
    </main>
  )
}
