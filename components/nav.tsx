'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Logo } from '@/components/logo'

const links = [
  { href: '/methodology', label: 'Methodology' },
  { href: '/docs', label: 'Docs' },
  { href: '/anchors', label: 'Anchors' },
  // { href: '/pricing', label: 'Pricing' },
  { href: '/about', label: 'About' },
]

export function Nav() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  return (
    <>
    <header className="sticky top-0 z-20 border-b border-linesoft bg-[#0B1B33]/85 backdrop-blur-md">
      <div className="mx-auto max-w-[1200px] px-6 sm:px-10">
        <nav className="flex items-center justify-between py-4">
          <Link href="/" aria-label="Axiom Lumen home" className="shrink-0">
            <Logo />
          </Link>

          <div className="hidden items-center md:flex">
            {links.map((link) => {
              const active = pathname === link.href
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={`border-l border-linesoft px-5 font-mono text-[12px] uppercase tracking-widest leading-8 transition-colors hover:text-ink ${
                    active ? 'text-gold' : 'text-muted'
                  }`}
                >
                  {link.label}
                </Link>
              )
            })}
            <Link
              href="/pricing"
              className="ml-5 border border-golddim px-4 py-2 font-mono text-[12px] uppercase tracking-widest text-gold transition-colors hover:border-gold hover:bg-gold hover:text-[#201404]"
            >
              Get access
            </Link>
          </div>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Toggle navigation menu"
            className="flex flex-col gap-[5px] p-2 md:hidden"
          >
            <span className="h-px w-5 bg-muted" />
            <span className="h-px w-5 bg-muted" />
            <span className="h-px w-5 bg-muted" />
          </button>
        </nav>
      </div>
    </header>

    {/* Mobile Drawer Navigation (moved outside header to avoid stacking context / containing block issues) */}
    <div className={`fixed inset-0 z-50 md:hidden transition-opacity duration-300 ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
      {/* Backdrop overlay */}
      <div 
        onClick={() => setOpen(false)}
        className="absolute inset-0 backdrop-blur-sm"
        style={{ backgroundColor: 'rgba(11, 27, 51, 0.6)' }}
      />

      {/* Drawer Panel - slides in from the left */}
      <div 
        className={`absolute inset-y-0 left-0 w-64 max-w-[80vw] border-r border-linesoft p-6 flex flex-col justify-between shadow-2xl transition-transform duration-300 ease-in-out ${open ? 'translate-x-0' : '-translate-x-full'}`}
        style={{ backgroundColor: '#0B1B33' }}
      >
        <div className="flex flex-col gap-8">
          <div className="flex items-center justify-between border-b border-linesoft pb-4">
            <Link href="/" onClick={() => setOpen(false)} className="shrink-0">
              <Logo small />
            </Link>
            <button 
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="p-1 font-mono text-[16px] text-muted hover:text-ink"
            >
              ✕
            </button>
          </div>
          
          <nav className="flex flex-col gap-2">
            {links.map((link) => {
              const active = pathname === link.href
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className={`border-b border-linesoft/40 py-3 font-mono text-[13px] uppercase tracking-widest transition-colors ${active ? 'text-gold' : 'text-muted hover:text-ink'}`}
                >
                  {link.label}
                </Link>
              )
            })}
          </nav>
        </div>

        <div className="pt-6 border-t border-linesoft">
          <Link
            href="/pricing"
            onClick={() => setOpen(false)}
            className="block w-full text-center border border-golddim py-3 font-mono text-[12px] uppercase tracking-widest text-gold transition-colors hover:border-gold hover:bg-gold hover:text-[#201404]"
          >
            Get access
          </Link>
        </div>
      </div>
    </div>
    </>
  )
}
