import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHero, DocSection, Ledger } from '@/components/site'

export const metadata: Metadata = {
  title: 'About',
  description:
    'Why Axiom Lumen is named what it is, the principles the brand holds itself to, and who the verification layer is built for.',
}

const traits = [
  {
    term: 'Authoritative, not arrogant',
    def: 'We publish our method and our mistakes with equal visibility. Authority comes from being checkable, not from tone.',
  },
  {
    term: 'Cerebral and sharp',
    def: 'Complex ideas explained simply — never dumbed down, never dressed up. If a sentence can be shorter, it is.',
  },
  {
    term: 'Neutral and objective',
    def: 'We report measured deviation and nothing else. No hype, no alarm, no favorites among anchors or assets.',
  },
  {
    term: 'Guardian-like',
    def: 'The job is to watch, continuously and without drama, so the people relying on this data don\u2019t have to.',
  },
]

const audiences = [
  {
    tag: 'BUILD',
    term: 'dApp developers',
    def: 'One verified data source to integrate, instead of five conflicting ones to reconcile by hand.',
  },
  {
    tag: 'ISSUE',
    term: 'Asset issuers and anchors',
    def: 'Continuous monitoring of your own published figures against network reality — and a documented right of reply.',
  },
  {
    tag: 'TRADE',
    term: 'Institutional traders',
    def: 'Corroborated order-book depth and supply figures before size is committed.',
  },
  {
    tag: 'RESEARCH',
    term: 'Ecosystem analysts',
    def: 'A dependable base layer for dashboards and reports on the health of the Stellar network.',
  },
]

export default function AboutPage() {
  return (
    <main>
      <PageHero
        docCode="AL-ORG-05 · ORGANIZATION"
        kicker="About"
        title="A foundational truth, measured in light."
      >
        Axiom Lumen is a verification and intelligence layer for the Stellar ecosystem. It exists
        because the network&apos;s data is scattered across sources that are not required to agree
        — and someone has to check.
      </PageHero>

      {/* 01 — The name: two ruled definitions, dictionary-style */}
      <DocSection num="01" label="The name" title="Axiom, then Lumen." wide>
        <div className="grid gap-x-14 gap-y-12 md:grid-cols-2">
          <div className="border-t-2 border-line pt-5">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="font-serif text-[26px] font-medium text-gold">Axiom</h3>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
                n. — foundational truth
              </span>
            </div>
            <p className="mt-4 max-w-[440px] text-sm leading-relaxed text-muted">
              An axiom is a statement that other reasoning is built on. That is the standard the
              product holds itself to: values that can serve as a starting point precisely because
              the method behind them is published, versioned, and checkable by anyone.
            </p>
          </div>
          <div className="border-t-2 border-line pt-5">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="font-serif text-[26px] font-medium text-gold">Lumen</h3>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
                n. — unit of light · XLM
              </span>
            </div>
            <p className="mt-4 max-w-[440px] text-sm leading-relaxed text-muted">
              Lumen is the unit of light — and lumens (XLM) are the native asset of the Stellar
              network this product watches. The name places the work: illumination of one specific
              ecosystem, not a general-purpose oracle for everything.
            </p>
          </div>
        </div>
      </DocSection>

      {/* 02 — Traits */}
      <DocSection
        num="02"
        label="How we operate"
        title="Four traits, applied to every sentence we publish."
      >
        <Ledger items={traits} />
      </DocSection>

      {/* 03 — Audience */}
      <DocSection
        num="03"
        label="Who it's for"
        title="Anyone who has to trust Stellar data with real stakes."
      >
        <Ledger numerals={false} items={audiences} />
      </DocSection>

      {/* 04 — Contact */}
      <DocSection num="04" label="Contact" title="Talk to us.">
        <p className="max-w-[620px] text-[15px] leading-relaxed text-muted">
          For API access questions or Institutional-tier terms, write to{' '}
          <a
            href="mailto:hello@axiomlumen.io"
            className="font-mono text-[14px] text-gold underline-offset-4 hover:underline"
          >
            hello@axiomlumen.io
          </a>
          . Anchors disputing a flag should use the dedicated channel described in the{' '}
          <Link href="/anchors" className="text-gold underline-offset-4 hover:underline">
            anchor procedure
          </Link>
          .
        </p>
      </DocSection>
    </main>
  )
}
