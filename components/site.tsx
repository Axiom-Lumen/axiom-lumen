import Link from 'next/link'
import type { ReactNode } from 'react'

/* ---------------------------------------------------------------------------
   Axiom Lumen design system — "public audit instrument"
   Rules this file enforces:
   1. No decorative boxes. A filled panel ALWAYS means live data artifact.
   2. Structure comes from hairline rules and a document margin column.
   3. Numerals are hanging, mono, and set in a true margin — never in pills.
   4. Gold appears only where a decision happens: CTAs, verified values, flags.
--------------------------------------------------------------------------- */

export function Wrap({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-[1200px] px-6 sm:px-10 ${className}`}>{children}</div>
}

/* Mono margin label — the only "kicker" style on the site */
export function Kicker({
  children,
  color = 'dim',
  className = '',
}: {
  children: ReactNode
  color?: 'gold' | 'cyan' | 'dim'
  className?: string
}) {
  const c = color === 'gold' ? 'text-gold' : color === 'cyan' ? 'text-cyan' : 'text-dim'
  return (
    <div className={`font-mono text-[11px] uppercase tracking-[0.14em] ${c} ${className}`}>
      {children}
    </div>
  )
}

/* ---------------------------------------------------------------------------
   Document grid. Every section on the site is a DocSection: a full-bleed
   hairline rule, then [margin column | content column]. The margin column
   carries a large hanging serif numeral and a mono label — the site's spine.
--------------------------------------------------------------------------- */
export function DocSection({
  num,
  label,
  title,
  lede,
  children,
  id,
  wide = false,
}: {
  num: string
  label: string
  title?: string
  lede?: ReactNode
  children?: ReactNode
  id?: string
  wide?: boolean
}) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-linesoft">
      <Wrap>
        <div className="grid gap-x-12 py-16 sm:py-20 md:grid-cols-[128px_minmax(0,1fr)]">
          <div className="mb-10 flex items-baseline gap-4 md:mb-0 md:block">
            <div
              aria-hidden="true"
              className="font-serif text-[34px] font-light leading-none tracking-[-0.02em] text-golddim"
            >
              {num}
            </div>
            <Kicker className="md:mt-4">{label}</Kicker>
          </div>
          <div className={wide ? '' : 'max-w-[760px]'}>
            {title && (
              <h2 className="text-balance font-serif text-[clamp(26px,3vw,36px)] font-medium leading-[1.15] tracking-[-0.01em]">
                {title}
              </h2>
            )}
            {lede && (
              <p className="mt-5 max-w-[620px] text-[15.5px] leading-relaxed text-muted">{lede}</p>
            )}
            {children && <div className={title || lede ? 'mt-10' : ''}>{children}</div>}
          </div>
        </div>
      </Wrap>
    </section>
  )
}

/* ---------------------------------------------------------------------------
   Page hero. Document-stamped: mono doc code top right, oversized Fraunces
   headline across the full measure. No badge pills, no empty right column.
--------------------------------------------------------------------------- */
export function PageHero({
  docCode,
  kicker,
  title,
  children,
}: {
  docCode: string
  kicker: string
  title: ReactNode
  children?: ReactNode
}) {
  return (
    <header className="pb-14 pt-16 sm:pt-20">
      <Wrap>
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3 border-b border-linesoft pb-4">
          <Kicker color="cyan">{kicker}</Kicker>
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-dim">
            {docCode}
          </div>
        </div>
        <h1 className="mt-10 max-w-[1000px] text-balance font-serif text-[clamp(38px,5.4vw,72px)] font-medium leading-[1.04] tracking-[-0.015em]">
          {title}
        </h1>
        {children && (
          <p className="mt-8 max-w-[640px] text-[17px] leading-relaxed text-muted">{children}</p>
        )}
      </Wrap>
    </header>
  )
}

/* Buttons — square. Gold fill only for the single primary decision. */
export function ButtonPrimary({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={`inline-block bg-gold px-7 py-3.5 text-sm font-medium text-[#201404] transition-colors hover:bg-goldhover ${className}`}
    >
      {children}
    </Link>
  )
}

export function ButtonSecondary({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-block border border-line px-7 py-3.5 text-sm text-ink transition-colors hover:border-muted"
    >
      {children}
    </Link>
  )
}

/* Arrow text link — the default in-flow action */
export function ArrowLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={`group inline-flex items-baseline gap-2 font-mono text-[13px] uppercase tracking-[0.08em] text-gold ${className}`}
    >
      <span className="underline decoration-golddim underline-offset-4 transition-colors group-hover:decoration-gold">
        {children}
      </span>
      <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
        {'→'}
      </span>
    </Link>
  )
}

/* ---------------------------------------------------------------------------
   Ledger — the replacement for card grids. Ruled rows on a shared grid:
   hanging mono numeral | term | definition. Reads like a schedule in a
   prospectus, not a feature grid.
--------------------------------------------------------------------------- */
export function Ledger({
  items,
  numerals = true,
}: {
  items: { num?: string; tag?: string; term: string; def: string }[]
  numerals?: boolean
}) {
  return (
    <dl>
      {items.map((item, i) => (
        <div
          key={item.term}
          className="grid gap-x-8 gap-y-2 border-t border-linesoft py-6 first:border-t-0 first:pt-0 sm:grid-cols-[56px_220px_minmax(0,1fr)] sm:py-7"
        >
          <div className="font-mono text-xs leading-6 text-dim">
            {numerals ? (item.num ?? String(i + 1).padStart(2, '0')) : (item.tag ?? '')}
          </div>
          <dt className="font-serif text-[18px] font-medium leading-snug">{item.term}</dt>
          <dd className="text-sm leading-relaxed text-muted">{item.def}</dd>
        </div>
      ))}
    </dl>
  )
}

/* Figures set inline on a rule — replaces "stat cards" */
export function FigureRow({
  figures,
}: {
  figures: { value: string; label: string }[]
}) {
  return (
    <div className="flex flex-wrap gap-x-14 gap-y-6 border-t border-linesoft pt-6">
      {figures.map((f) => (
        <div key={f.label}>
          <div className="font-serif text-[30px] font-medium leading-none text-gold">
            {f.value}
          </div>
          <div className="mt-2 font-mono text-[11px] uppercase tracking-widest text-dim">
            {f.label}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------------------
   Data artifacts — the ONLY filled panels on the site.
--------------------------------------------------------------------------- */
export function CodePanel({
  children,
  label,
  className = '',
}: {
  children: ReactNode
  label?: string
  className?: string
}) {
  return (
    <figure className={className}>
      {label && (
        <figcaption className="flex items-center justify-between border border-b-0 border-linesoft bg-surface px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
          <span>{label}</span>
          <span aria-hidden="true" className="text-golddim">
            ●
          </span>
        </figcaption>
      )}
      <pre className="overflow-x-auto border border-linesoft bg-deep p-5 font-mono text-[12.5px] leading-[1.7] text-muted sm:p-6">
        {children}
      </pre>
    </figure>
  )
}

export function K({ children }: { children: ReactNode }) {
  return <span className="text-cyan">{children}</span>
}

export function S({ children }: { children: ReactNode }) {
  return <span className="text-gold">{children}</span>
}

export { ConfidenceJson, DataArtifactEmpty } from './confidence-json'

/* Ruled notice — no box. A gold rule and a mono label carry the weight. */
export function ShortDisclaimer({ className = '' }: { className?: string }) {
  return (
    <aside className={`border-l-2 border-golddim py-1 pl-6 ${className}`}>
      <Kicker color="gold" className="mb-2.5">
        Notice
      </Kicker>
      <p className="max-w-[620px] text-[13px] leading-relaxed text-muted">
        Axiom Lumen reports measured deviations between published and on-chain data. It does not
        state or imply a solvency, fraud, or financial-health determination about any anchor,
        issuer, or asset, and does not provide investment advice. See the{' '}
        <Link href="/methodology" className="text-gold underline-offset-2 hover:underline">
          full methodology and disclaimer
        </Link>
        .
      </p>
    </aside>
  )
}

/* Severity table — ruled, unboxed. Double rule under the header like a
   printed rate schedule. */
export function SeverityTable() {
  const rows = [
    {
      level: 'Info',
      color: 'text-cyan',
      trigger: 'Deviation below 0.1% between any two sources, or a single stale source',
      treatment: 'Logged in the audit trail. Included in API responses. Not surfaced publicly.',
    },
    {
      level: 'Warning',
      color: 'text-gold',
      trigger: 'Deviation of 0.1–1% persisting across three consecutive measurement windows',
      treatment:
        'Flagged in API responses and the dashboard. The affected anchor is notified before any public listing.',
    },
    {
      level: 'Critical',
      color: 'text-danger',
      trigger:
        'Deviation above 1%, or a Warning unresolved after the right-of-reply window closes',
      treatment:
        "Publicly listed with full source data, timestamps, and the anchor's response if one was provided.",
    },
  ]
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b-2 border-line">
            <th className="py-3 pr-5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-dim">
              Severity
            </th>
            <th className="px-5 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-dim">
              Trigger
            </th>
            <th className="py-3 pl-5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-dim">
              Public treatment
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.level} className="border-b border-linesoft last:border-b-0">
              <td className={`py-5 pr-5 align-top font-mono text-[13px] font-medium ${row.color}`}>
                {row.level}
              </td>
              <td className="px-5 py-5 align-top leading-relaxed text-muted">{row.trigger}</td>
              <td className="py-5 pl-5 align-top leading-relaxed text-muted">{row.treatment}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
