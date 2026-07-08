import {
  Wrap,
  Kicker,
  DocSection,
  Ledger,
  FigureRow,
  ArrowLink,
  ButtonPrimary,
  ButtonSecondary,
  ConfidenceJson,
} from '@/components/site'
import { Hero } from '@/components/ui/home/hero'
import { ReconciliationStrip } from '@/components/ui/home/reconiclation-strip'
import { audiences, pipeline, problems } from '@/lib/home/data'


export default function HomePage() {
  return (
    <main>
      {/* Hero — the type is the design. Full measure, no dead right column. */}
      <Hero />

      {/* 01 — Problem */}
      <DocSection
        num="01"
        label="The problem"
        title="Stellar is fast. Its data is not aligned."
        lede="Ecosystem data lives across horizon instances, archive nodes, DEX order books, anchor APIs, and external oracles — and none of them are required to agree."
        id="product"
      >
        <Ledger items={problems} />
      </DocSection>

      {/* 02 — Pipeline */}
      <DocSection
        num="02"
        label="The engine"
        title="One engine. Three jobs."
        lede="Axiom Lumen doesn't just display Stellar data — it corroborates it."
      >
        <Ledger numerals={false} items={pipeline} />
      </DocSection>

      {/* 03 — Methodology teaser */}
      <DocSection
        num="03"
        label="Methodology"
        title="Confidence, not certainty theater."
        lede="Every value Axiom Lumen returns comes with its sources, its disagreements, and a versioned scoring method behind it — published, not hidden."
        wide
      >
        <div className="grid items-start gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_460px]">
          <div className="max-w-[520px]">
            <p className="text-[15px] leading-relaxed text-muted">
              Each source carries a base trust weight, decayed by staleness, then combined by
              weighted median — so one lagging anchor can&apos;t distort the reference value.
              Discrepancies are never discarded: they&apos;re logged, timestamped, and kept for
              audit even after they resolve.
            </p>
            <FigureRow
              figures={[
                { value: 'v1.3', label: 'methodology version' },
                { value: '5', label: 'source classes weighted' },
                { value: '100%', label: 'discrepancies logged' },
              ]}
            />
            <div className="mt-10">
              <ArrowLink href="/methodology">Read the full methodology</ArrowLink>
            </div>
          </div>
          <ConfidenceJson />
        </div>
      </DocSection>

      {/* 04 — Audience */}
      <DocSection
        num="04"
        label="Who it's for"
        title="Built for anyone who has to trust Stellar data with real stakes."
        id="audience"
      >
        <Ledger numerals={false} items={audiences} />
      </DocSection>

      {/* Closing — left-aligned statement, not a centered CTA block */}
      <section className="border-t border-line">
        <Wrap>
          <div className="grid gap-x-12 py-20 sm:py-28 md:grid-cols-[128px_minmax(0,1fr)]">
            <Kicker color="gold" className="mb-8 md:mb-0 md:mt-2">
              Start verifying
            </Kicker>
            <div>
              <p className="max-w-[820px] text-balance font-serif text-[clamp(30px,4.2vw,52px)] font-medium leading-[1.1] tracking-[-0.015em]">
                Stop trusting a single source blindly.{' '}
                <span className="text-muted">
                  Query certified Stellar metrics in minutes.
                </span>
              </p>
              <div className="mt-10 flex flex-wrap gap-3">
                <ButtonPrimary href="/pricing">Get API access</ButtonPrimary>
                <ButtonSecondary href="/about">Talk to us</ButtonSecondary>
              </div>
            </div>
          </div>
        </Wrap>
      </section>
    </main>
  )
}
