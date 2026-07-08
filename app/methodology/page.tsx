import type { Metadata } from 'next'
import Link from 'next/link'
import {
  PageHero,
  DocSection,
  CodePanel,
  ConfidenceJson,
  SeverityTable,
  Kicker,
  FigureRow,
} from '@/components/site'

export const metadata: Metadata = {
  title: 'Methodology',
  description:
    'How Axiom Lumen weights sources, decays stale data, computes weighted-median consensus, scores confidence, and handles discrepancies — published in full, versioned as v1.3.',
}

const sourceClasses = [
  {
    cls: 'Canonical ledger state',
    example: 'Stellar Core validator quorum, closed-ledger data',
    weight: '1.0',
  },
  {
    cls: 'Archive',
    example: 'Horizon history archives, full-history nodes',
    weight: '0.9',
  },
  {
    cls: 'DEX',
    example: 'Stellar DEX order books and trade streams',
    weight: '0.85',
  },
  {
    cls: 'Anchor self-reported',
    example: 'Anchor reserve endpoints, published supply figures',
    weight: '0.5',
  },
  {
    cls: 'Third-party oracle',
    example: 'External price and reserve attestation feeds',
    weight: '0.4',
  },
]

export default function MethodologyPage() {
  return (
    <main>
      <PageHero
        docCode="AL-SPEC-01 · METHODOLOGY V1.3"
        kicker="Methodology"
        title="How Axiom Lumen decides what to report."
      >
        This page exists so that no one has to take our numbers on faith. It documents, in full,
        how sources are classified and weighted, how stale data loses influence, how disagreement
        between sources is measured and scored, and what happens when a discrepancy is found. The
        method is versioned; when it changes, the version number changes with it.
      </PageHero>

      {/* 01 — Source classification */}
      <DocSection
        num="01"
        label="Source classification"
        title="Five source classes, five base weights."
        lede="Every source Axiom Lumen ingests is assigned to one of five classes. The class determines its base trust weight — a fixed prior reflecting how directly the source observes ledger state. Canonical ledger data is the reference; self-reported and third-party data start from a lower position and must earn agreement."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b-2 border-line">
                <th className="py-3 pr-5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-dim">
                  Source class
                </th>
                <th className="px-5 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-dim">
                  Example source
                </th>
                <th className="py-3 pl-5 text-right font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-dim">
                  Base weight
                </th>
              </tr>
            </thead>
            <tbody>
              {sourceClasses.map((row) => (
                <tr key={row.cls} className="border-b border-linesoft last:border-b-0">
                  <td className="py-4 pr-5 align-top font-medium text-ink">{row.cls}</td>
                  <td className="px-5 py-4 align-top leading-relaxed text-muted">{row.example}</td>
                  <td className="py-4 pl-5 text-right align-top font-mono text-[13px] tabular-nums text-gold">
                    {row.weight}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DocSection>

      {/* 02 — Staleness decay */}
      <DocSection
        num="02"
        label="Staleness decay"
        title="Old data loses its vote."
        lede="A source's base weight only applies while its data is fresh. As a reading ages, its effective weight decays exponentially, so a source that stops updating fades out of the consensus rather than anchoring it to the past. The decay constant λ is tuned per metric: fast-moving values like order-book depth decay in seconds, slow-moving values like total trustline counts decay over minutes."
      >
        <CodePanel label="Effective weight" className="max-w-[640px]">
          <code>effective_weight = base_weight × e^(−λ × age_seconds)</code>
        </CodePanel>
        <p className="mt-8 max-w-[620px] text-[15px] leading-relaxed text-muted">
          A canonical source that is thirty seconds stale can therefore carry less influence than
          a DEX feed observed one second ago. Freshness is measured against the source&apos;s own
          reported timestamp where available, and against time of receipt otherwise.
        </p>
      </DocSection>

      {/* 03 — Cross-source comparison */}
      <DocSection
        num="03"
        label="Cross-source comparison"
        title="Weighted median, not weighted mean."
      >
        <div className="flex max-w-[620px] flex-col gap-4 text-[15px] leading-relaxed text-muted">
          <p>
            Once effective weights are computed, all available readings for a metric are compared.
            Two things come out of that comparison: an agreement score — the weighted proportion
            of sources whose readings fall within the metric&apos;s tolerance band of one another —
            and a reference value, computed as the weighted median of all readings.
          </p>
          <p>
            The median is chosen over the mean deliberately. A weighted mean lets a single outlier
            drag the reference value toward it in proportion to how wrong it is: one anchor
            misreporting supply by 40% would visibly distort a mean even at 0.5 weight. A weighted
            median is robust to this — an outlier can only shift the result by displacing rank,
            not by magnitude. The wrong value is flagged as a discrepancy; it never contaminates
            the number we report.
          </p>
          <p>
            Disagreeing readings are not discarded. Every deviation is logged with its source,
            delta, and timestamp, and retained for audit even after the sources reconverge.
          </p>
        </div>
      </DocSection>

      {/* 04 — Severity */}
      <DocSection
        num="04"
        label="Discrepancy severity"
        title="Three levels, defined triggers."
        lede="When sources disagree beyond tolerance, the deviation is classified into one of three severity levels. The triggers are mechanical — a severity level is a statement about measured deviation, never a judgment about why the deviation exists."
      >
        <SeverityTable />
      </DocSection>

      {/* 05 — Confidence output */}
      <DocSection
        num="05"
        label="Confidence output"
        title="A number you can interrogate."
        wide
      >
        <div className="grid items-start gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_460px]">
          <div className="flex max-w-[520px] flex-col gap-4 text-[15px] leading-relaxed text-muted">
            <p>
              Every value returned by the API carries a confidence score between 0 and 1. It is a
              function of the agreement score, the total effective weight of contributing sources,
              and the spread of their readings. A score of 1.0 means every weighted source agreed
              within tolerance on fresh data. A score near 0 means the sources available could not
              corroborate one another.
            </p>
            <p>
              Confidence is not a probability that the value is correct. It is a measure of how
              well the available sources corroborate one another under this method, at this
              version. The response tells you which sources agreed, which did not, and by how much
              — so you can apply your own threshold rather than inheriting ours.
            </p>
          </div>
          <ConfidenceJson />
        </div>
      </DocSection>

      {/* 06 — Trust posture: two ruled columns, gold rule vs danger rule */}
      <DocSection
        num="06"
        label="Trust posture"
        title="What we claim. What we don't."
        wide
      >
        <div className="grid gap-x-14 gap-y-12 md:grid-cols-2">
          <div className="border-t-2 border-gold pt-5">
            <Kicker color="gold" className="mb-6">
              What we claim
            </Kicker>
            <ul className="flex flex-col">
              {[
                "\u201CAnchor X's self-reported reserve figure deviated from on-chain supply by 2.1% for 14 hours.\u201D",
                '\u201CFour of five weighted sources agree on this value within tolerance; confidence 0.94.\u201D',
                '\u201CThis discrepancy was first observed at 09:41 UTC and resolved at 23:12 UTC.\u201D',
              ].map((claim) => (
                <li
                  key={claim}
                  className="border-b border-linesoft py-4 text-sm leading-relaxed text-muted last:border-b-0"
                >
                  {claim}
                </li>
              ))}
            </ul>
          </div>
          <div className="border-t-2 border-danger pt-5">
            <div className="mb-6 font-mono text-[11px] uppercase tracking-[0.14em] text-danger">
              What we never claim
            </div>
            <ul className="flex flex-col">
              {[
                '\u201CAnchor X is insolvent\u201D — or any solvency determination.',
                '\u201CAnchor X is committing fraud\u201D — or any characterization of intent.',
                '\u201CYou should exit this asset\u201D — or any investment recommendation, in any form.',
              ].map((claim) => (
                <li
                  key={claim}
                  className="border-b border-linesoft py-4 text-sm leading-relaxed text-muted last:border-b-0"
                >
                  {claim}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-10 max-w-[620px] text-sm leading-relaxed text-muted">
          The distinction is structural, not stylistic. Measured deviation between published and
          on-chain data is an observable fact. Solvency, intent, and financial health are
          conclusions that require information we do not have and do not seek.
        </p>
      </DocSection>

      {/* 07 — Right of reply */}
      <DocSection
        num="07"
        label="Right of reply"
        title="Flagged parties hear from us first."
      >
        <div className="flex max-w-[620px] flex-col gap-4 text-[15px] leading-relaxed text-muted">
          <p>
            Before any Warning-level discrepancy involving a named anchor or issuer is listed
            publicly, the affected party is notified at their registered contact endpoint with the
            full measurement record: sources, timestamps, deltas, and the severity classification.
          </p>
          <p>
            The reply window is 72 hours. Within it, the anchor can supply a correction, an
            explanation, or evidence that the deviation originates from a data or timing artifact
            on our side. If the explanation resolves the discrepancy, the flag is closed and the
            resolution is recorded in the audit log. If it does not, the discrepancy is published
            together with the anchor&apos;s response, verbatim and unedited.
          </p>
          <p>
            The process for anchors is documented in full on the{' '}
            <Link href="/anchors" className="text-gold underline-offset-4 hover:underline">
              anchors and issuers page
            </Link>
            .
          </p>
        </div>
      </DocSection>

      {/* 08 — Disclaimer: set as legal text, hanging under a heavy rule */}
      <DocSection num="08" label="Disclaimer" title="Full legal disclaimer.">
        <div className="max-w-[680px] border-t-2 border-line pt-6">
          <div className="flex flex-col gap-4 text-sm leading-relaxed text-muted">
            <p>
              Axiom Lumen reports measured deviations between published and on-chain data on the
              Stellar network. Nothing published by Axiom Lumen — including discrepancy flags,
              severity classifications, confidence scores, or any commentary accompanying them —
              states or implies a determination of solvency, fraud, or financial health with
              respect to any anchor, issuer, asset, or other party.
            </p>
            <p>
              Axiom Lumen is not a financial advisor, auditor, or rating agency. No output of this
              service constitutes financial, investment, legal, or accounting advice, and no
              output should be relied upon as the basis for any investment decision. Data may be
              incomplete, delayed, or affected by upstream source errors; confidence scores
              quantify source corroboration under the published method, not correctness.
            </p>
            <p>
              Users are responsible for their own evaluation of any information obtained through
              this service. Anchors and issuers named in a discrepancy have a documented right of
              reply as described in section 07 of this methodology.
            </p>
          </div>
        </div>
      </DocSection>

      {/* Version colophon */}
      <DocSection num="—" label="Version">
        <FigureRow figures={[{ value: 'v1.3', label: 'current methodology version' }]} />
        <p className="mt-8 max-w-[520px] text-sm leading-relaxed text-muted">
          Changes to weights, decay constants, severity triggers, or the consensus function
          increment this version. A full changelog will be published at{' '}
          <span className="font-mono text-[13px] text-dim">/methodology/changelog</span> (coming
          with v1.4).
        </p>
      </DocSection>
    </main>
  )
}
