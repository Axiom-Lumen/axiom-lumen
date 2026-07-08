import type { Metadata } from 'next'
import Link from 'next/link'
import { Wrap, PageHero, DocSection, ArrowLink } from '@/components/site'

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'The Axiom Lumen rate schedule — Developer (free), Growth, and Institutional. Every tier returns the same verified values; higher tiers see more corroboration data at higher volume.',
}

/* One rate schedule, prospectus-style. Tiers are columns; no highlighted
   "winner" — the copy's own argument is that every tier gets the same truth. */

const tierHeads = [
  { name: 'Developer', price: 'Free', note: 'no card required', cta: 'Get access', href: '/docs' },
  { name: 'Growth', price: '$249', note: 'per month', cta: 'Get access', href: '/docs' },
  {
    name: 'Institutional',
    price: 'Custom',
    note: 'annual agreement',
    cta: 'Talk to us',
    href: '/about',
  },
]

const schedule: { feature: string; note?: string; values: [string, string, string] }[] = [
  { feature: 'Verified values + confidence scores', values: ['Included', 'Included', 'Included'] },
  { feature: 'REST API rate limit', values: ['60 req/min', '1,000 req/min', 'Custom'] },
  { feature: 'All v1 endpoints', values: ['Included', 'Included', 'Included'] },
  { feature: 'WebSocket streams', values: ['—', 'Included', 'Included'] },
  {
    feature: 'Discrepancy visibility',
    note: 'source classes shown in the discrepancies array',
    values: ['Single class', 'All classes', 'All classes'],
  },
  { feature: 'Historical discrepancy log', values: ['—', 'Included', 'Included'] },
  { feature: 'Anchor-dispute tooling', values: ['—', '—', 'Included'] },
  {
    feature: 'Support',
    values: ['Community', 'Email, 1 business day', 'Dedicated engineer'],
  },
  { feature: 'Uptime SLA', values: ['—', '—', '99.9%'] },
  { feature: 'Data retention terms', values: ['Standard', 'Standard', 'Custom'] },
]

export default function PricingPage() {
  return (
    <main>
      <PageHero
        docCode="AL-RATE-03 · RATE SCHEDULE"
        kicker="API access"
        title="Pay for depth, not for access."
      >
        Every tier returns the same verified values with the same confidence scores. Higher tiers
        see more of the corroboration data behind them, at higher volume. There is no premium
        truth.
      </PageHero>

      <section className="border-t border-line">
        <Wrap>
          <div className="overflow-x-auto py-14 sm:py-16">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <caption className="sr-only">
                Axiom Lumen rate schedule: features by access tier
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="w-[30%] pb-8 pr-6 align-bottom">
                    <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-dim">
                      Schedule of access
                    </span>
                  </th>
                  {tierHeads.map((tier) => (
                    <th key={tier.name} scope="col" className="pb-8 pl-6 pr-6 align-bottom">
                      <div className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-cyan">
                        {tier.name}
                      </div>
                      <div className="mt-3 font-serif text-[38px] font-medium leading-none text-ink">
                        {tier.price}
                      </div>
                      <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-dim">
                        {tier.note}
                      </div>
                    </th>
                  ))}
                </tr>
                <tr aria-hidden="true">
                  <td colSpan={4} className="border-t-2 border-line" />
                </tr>
              </thead>
              <tbody>
                {schedule.map((row) => (
                  <tr key={row.feature} className="border-b border-linesoft">
                    <th scope="row" className="py-4 pr-6 text-left align-top">
                      <span className="text-sm font-medium text-ink">{row.feature}</span>
                      {row.note && (
                        <span className="mt-1 block text-xs font-normal leading-relaxed text-dim">
                          {row.note}
                        </span>
                      )}
                    </th>
                    {row.values.map((v, i) => (
                      <td
                        key={tierHeads[i].name}
                        className={`px-6 py-4 align-top text-sm ${
                          v === '—' ? 'text-dim' : 'text-muted'
                        }`}
                      >
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td className="pt-8" />
                  {tierHeads.map((tier) => (
                    <td key={tier.name} className="px-6 pt-8 align-top">
                      <Link
                        href={tier.href}
                        className="inline-block border border-golddim px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.1em] text-gold transition-colors hover:border-gold hover:bg-gold hover:text-[#201404]"
                      >
                        {tier.cta}
                      </Link>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </Wrap>
      </section>

      <DocSection num="—" label="Notes to the schedule">
        <ol className="max-w-[620px]">
          {[
            'Rate limits are enforced per API key and returned in the X-RateLimit-* response headers on every request.',
            'Discrepancy visibility governs how much of the corroboration record is returned — never whether a discrepancy exists. A deviation that crosses a public threshold is public at every tier.',
            'Institutional terms, including custom endpoints and retention, are set in the annual agreement.',
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
