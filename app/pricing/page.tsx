import type { Metadata } from 'next'
import Link from 'next/link'
import { Wrap, PageHero, DocSection, ArrowLink } from '@/components/site'

export const metadata: Metadata = {
  title: 'API access',
  description:
    'How to use Axiom Lumen locally or with hosted API keys. Paid self-service, commercial SLAs, and public v1 general availability are not offered yet.',
}

const accessRows: { feature: string; note?: string; value: string }[] = [
  { feature: 'Local anonymous reads', note: 'default unless authentication is explicitly enabled', value: 'Available' },
  { feature: 'Hosted API keys and quotas', note: 'opaque X-Axiom-Key, hashed storage, rotation, revocation', value: 'Available when enabled' },
  { feature: 'Implemented v1 metric routes', note: 'latest-ledger, supply, depth, trustlines, reviewed reserves, snapshot SSE', value: 'Available' },
  { feature: 'Public status page', value: 'Available' },
  { feature: 'Self-service checkout or billed plans', value: 'Not offered' },
  { feature: 'Commercial uptime SLA', value: 'Not offered' },
  { feature: 'Public historical discrepancy log API', value: 'Not offered' },
  { feature: 'Self-service claimant or dispute portal', value: 'Not offered' },
  { feature: 'Named-party publication', note: 'disabled until product/legal approval is recorded', value: 'Fail-closed' },
]

export default function PricingPage() {
  return (
    <main>
      <PageHero
        docCode="AL-RATE-03 · ACCESS"
        kicker="API access"
        title="Use the implemented API. Do not buy a plan that does not exist."
      >
        Axiom Lumen is not a billed hosted product yet. Local development stays anonymous by default. Operators
        can require API keys and enforce quotas, but there is no checkout, no published commercial SLA, and no
        public v1 general-availability claim.
      </PageHero>

      <section className="border-t border-line">
        <Wrap>
          <div className="overflow-x-auto py-14 sm:py-16">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <caption className="sr-only">Current Axiom Lumen access, excluding unshipped paid capabilities</caption>
              <thead>
                <tr>
                  <th scope="col" className="w-[45%] pb-8 pr-6 align-bottom">
                    <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-dim">
                      What exists today
                    </span>
                  </th>
                  <th scope="col" className="pb-8 pl-6 align-bottom">
                    <div className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-cyan">
                      Status
                    </div>
                    <div className="mt-3 font-serif text-[32px] font-medium leading-none text-ink">
                      No billed plans
                    </div>
                    <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-dim">
                      operator-issued keys only
                    </div>
                  </th>
                </tr>
                <tr aria-hidden="true">
                  <td colSpan={2} className="border-t-2 border-line" />
                </tr>
              </thead>
              <tbody>
                {accessRows.map((row) => (
                  <tr key={row.feature} className="border-b border-linesoft">
                    <th scope="row" className="py-4 pr-6 text-left align-top">
                      <span className="text-sm font-medium text-ink">{row.feature}</span>
                      {row.note && (
                        <span className="mt-1 block text-xs font-normal leading-relaxed text-dim">
                          {row.note}
                        </span>
                      )}
                    </th>
                    <td className="px-6 py-4 align-top text-sm text-muted">{row.value}</td>
                  </tr>
                ))}
                <tr>
                  <td className="pt-8" />
                  <td className="px-6 pt-8 align-top">
                    <Link
                      href="/docs"
                      className="inline-block border border-golddim px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.1em] text-gold transition-colors hover:border-gold hover:bg-gold hover:text-[#201404]"
                    >
                      Read the API
                    </Link>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Wrap>
      </section>

      <DocSection num="—" label="Notes to the schedule">
        <ol className="max-w-[620px]">
          {[
            'Hosted API rate limits are enforced per API key and returned in X-RateLimit-* headers on authenticated application responses.',
            'Publication-approved discrepancies can appear on current snapshot routes; there is no separate historical discrepancy log endpoint.',
            'Named-party reserve disclosures stay empty until a recorded product/legal approval enables publication.',
          ].map((note, i) => (
            <li
              key={note}
              className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-4 border-t border-linesoft py-4 first:border-t-0 first:pt-0"
            >
              <span className="font-mono text-xs leading-6 text-dim">{`(${i + 1})`}</span>
              <span className="text-sm leading-relaxed text-muted">{note}</span>
            </li>
          ))}
        </ol>
        <div className="mt-10">
          <ArrowLink href="/docs">Read the API documentation</ArrowLink>
        </div>
      </DocSection>
    </main>
  )
}
