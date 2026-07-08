import Link from 'next/link'
import { Logo } from '@/components/logo'

const index = [
  { href: '/', label: 'Index', code: 'AL-00' },
  { href: '/methodology', label: 'Methodology', code: 'AL-01' },
  { href: '/docs', label: 'API reference', code: 'AL-02' },
  { href: '/pricing', label: 'Rate schedule', code: 'AL-03' },
  { href: '/anchors', label: 'Anchor procedure', code: 'AL-04' },
  { href: '/about', label: 'Organization', code: 'AL-05' },
]

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto max-w-[1200px] px-6 sm:px-10">
        <div className="grid gap-x-12 gap-y-10 py-14 md:grid-cols-[minmax(0,1fr)_360px]">
          <div>
            <Link href="/" aria-label="Axiom Lumen home" className="inline-block">
              <Logo small />
            </Link>
            <p className="mt-6 max-w-[520px] text-[12.5px] leading-relaxed text-dim">
              Axiom Lumen surfaces discrepancies between published and on-chain data on the
              Stellar network. This is not a solvency determination for any anchor or issuer, and
              should not be relied upon as financial or investment advice.
            </p>
            <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
              Methodology v1.3 · All discrepancies logged
            </p>
          </div>
          <nav aria-label="Document index">
            <div className="border-b-2 border-line pb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
              Document index
            </div>
            <ul>
              {index.map((doc) => (
                <li key={doc.href}>
                  <Link
                    href={doc.href}
                    className="group flex items-baseline justify-between gap-4 border-b border-linesoft py-2.5"
                  >
                    <span className="text-[13px] text-muted transition-colors group-hover:text-ink">
                      {doc.label}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
                      {doc.code}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  )
}
