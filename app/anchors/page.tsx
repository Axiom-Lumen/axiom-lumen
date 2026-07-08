import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHero, DocSection, SeverityTable, CodePanel, S } from '@/components/site'

export const metadata: Metadata = {
  title: 'For anchors and issuers',
  description:
    'How the right-of-reply process works if your anchor is named in a discrepancy, how to claim and verify your endpoint, and how to dispute a flag.',
}

const replySteps = [
  {
    title: 'Detection',
    body: 'A deviation between your published data and on-chain state crosses the Warning threshold and persists across three consecutive measurement windows. The severity classification is mechanical — see the trigger table below.',
  },
  {
    title: 'Notification',
    body: 'We send the full measurement record — every source reading, timestamp, delta, and the severity classification — to your registered contact endpoint. Nothing is published at this point.',
  },
  {
    title: 'Reply window',
    body: 'You have 72 hours to respond. A response can be a correction to your published data, an explanation of the deviation, or evidence that the discrepancy originates from a data or timing artifact on our side.',
  },
  {
    title: 'Review',
    body: 'If your response resolves the discrepancy — the sources reconverge or you demonstrate a measurement artifact — the flag is closed and the resolution is recorded in the audit log. Closed flags are never published as active discrepancies.',
  },
  {
    title: 'Disclosure',
    body: 'If the deviation persists after the window closes, the discrepancy is published with the full measurement record and your response, verbatim and unedited. You are never quoted selectively.',
  },
]

export default function AnchorsPage() {
  return (
    <main>
      <PageHero
        docCode="AL-PROC-04 · ANCHOR PROCEDURE"
        kicker="For anchors and issuers"
        title="If we flag your data, here is exactly what happens."
      >
        Axiom Lumen continuously compares anchor-published figures against on-chain state. This
        page documents the process that runs when those figures deviate — including your right to
        reply before anything is disclosed publicly.
      </PageHero>

      {/* Prominent notice — most legally sensitive page. Gold rule, no box. */}
      <DocSection num="—" label="Notice" title="What a flag is — and what it is not.">
        <div className="max-w-[620px] border-l-2 border-golddim pl-6">
          <div className="flex flex-col gap-3 text-[15px] leading-relaxed text-muted">
            <p>
              A discrepancy flag is a statement of measured deviation between published and
              on-chain data, and nothing more. It does not state or imply a determination of
              solvency, fraud, or financial health with respect to your anchor, your assets, or
              your business, and it is not investment advice to anyone.
            </p>
            <p>
              We never characterize intent, never speculate on causes, and never recommend action
              on the basis of a flag. The full legal disclaimer is published in the{' '}
              <Link href="/methodology" className="text-gold underline-offset-4 hover:underline">
                methodology, section 08
              </Link>
              .
            </p>
          </div>
        </div>
      </DocSection>

      {/* 01 — Right of reply: true timeline with a running vertical rule */}
      <DocSection
        num="01"
        label="Right of reply"
        title="Five steps, in order, every time."
      >
        <ol className="max-w-[640px]">
          {replySteps.map((step, i) => (
            <li key={step.title} className="relative pb-10 pl-10 last:pb-0">
              {/* running rule; stops at the last step */}
              {i < replySteps.length - 1 && (
                <span
                  aria-hidden="true"
                  className="absolute left-[5px] top-4 h-full w-px bg-line"
                />
              )}
              <span
                aria-hidden="true"
                className={`absolute left-0 top-[7px] size-[11px] rotate-45 border ${
                  i === replySteps.length - 1
                    ? 'border-gold bg-gold'
                    : 'border-line bg-navy'
                }`}
              />
              <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-dim">
                Step 0{i + 1}
              </div>
              <h3 className="mt-1.5 font-serif text-[19px] font-medium">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </DocSection>

      {/* 02 — Claiming */}
      <DocSection
        num="02"
        label="Claiming your anchor"
        title="Verify your endpoint before you need it."
        lede={
          <>
            Registering a verified contact endpoint is what makes the right-of-reply process work.
            Unclaimed anchors are notified at the contact listed in their{' '}
            <code className="font-mono text-[13px] text-cyan">stellar.toml</code>, which is slower
            and less reliable. Claiming takes two steps:
          </>
        }
      >
        <div className="max-w-[640px]">
          <div className="grid gap-x-4 gap-y-2 border-t border-linesoft py-6 sm:grid-cols-[56px_200px_minmax(0,1fr)]">
            <div className="font-mono text-xs leading-6 text-dim">01</div>
            <div className="font-serif text-[17px] font-medium leading-snug">
              Prove domain control
            </div>
            <p className="text-sm leading-relaxed text-muted">
              Add a verification entry to the{' '}
              <code className="font-mono text-[13px] text-cyan">stellar.toml</code> served from
              your anchor&apos;s home domain. We confirm it matches the issuing account on chain.
            </p>
          </div>
          <div className="grid gap-x-4 gap-y-2 border-t border-linesoft py-6 sm:grid-cols-[56px_200px_minmax(0,1fr)]">
            <div className="font-mono text-xs leading-6 text-dim">02</div>
            <div className="font-serif text-[17px] font-medium leading-snug">
              Register a contact endpoint
            </div>
            <p className="text-sm leading-relaxed text-muted">
              Provide a monitored email address or webhook URL for discrepancy notifications. We
              test it with a signed challenge before it becomes active.
            </p>
          </div>
          <CodePanel label="stellar.toml — verification entry" className="mt-8">
            <code>
              {'[[VERIFICATION]]\nprovider = '}
              <S>{'"axiomlumen.io"'}</S>
              {'\nclaim_token = '}
              <S>{'"al_claim_9f2c..."'}</S>
            </code>
          </CodePanel>
        </div>
      </DocSection>

      {/* 03 — Severity */}
      <DocSection
        num="03"
        label="Severity thresholds"
        title="What triggers a Warning. What triggers a Critical."
        lede="These are the same thresholds published in the methodology. Info-level deviations are logged but never surfaced publicly; only a Warning starts the right-of-reply clock."
      >
        <SeverityTable />
      </DocSection>

      {/* 04 — Disputes */}
      <DocSection
        num="04"
        label="Disputing a flag"
        title="The dispute channel is always open."
      >
        <div className="flex max-w-[620px] flex-col gap-4 text-[15px] leading-relaxed text-muted">
          <p>
            Disputes are not limited to the 72-hour reply window. If you believe a published
            discrepancy is wrong — at any time, including after disclosure — write to{' '}
            <a
              href="mailto:disputes@axiomlumen.io"
              className="font-mono text-[14px] text-gold underline-offset-4 hover:underline"
            >
              disputes@axiomlumen.io
            </a>{' '}
            with the flag identifier and your evidence.
          </p>
          <p>
            Every dispute receives a substantive response within three business days. If a
            published flag is found to be a measurement error on our side, it is retracted with a
            correction notice in the same audit log where the flag appeared — retractions are as
            public as the flags they correct. Institutional-tier anchors also have access to
            dedicated dispute tooling; see{' '}
            <Link href="/pricing" className="text-gold underline-offset-4 hover:underline">
              the rate schedule
            </Link>
            .
          </p>
        </div>
      </DocSection>
    </main>
  )
}
