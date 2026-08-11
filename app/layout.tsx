import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import { Nav } from '@/components/nav'
import { Footer } from '@/components/footer'
import './globals.css'

const fraunces = localFont({
  src: './fonts/fraunces-variable.woff2',
  weight: '100 900',
  style: 'normal',
  variable: '--font-fraunces',
  display: 'swap',
  fallback: ['Georgia', 'serif'],
  adjustFontFallback: 'Times New Roman',
})

const plexSans = localFont({
  src: [
    { path: './fonts/ibm-plex-sans-regular.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-sans-medium.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-sans-semibold.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-plex-sans',
  display: 'swap',
  fallback: ['Arial', 'sans-serif'],
})

const plexMono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-regular.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-medium.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-plex-mono',
  display: 'swap',
  fallback: ['ui-monospace', 'monospace'],
  adjustFontFallback: false,
})

export const metadata: Metadata = {
  title: {
    default: 'Axiom Lumen — the verification layer for Stellar',
    template: '%s — Axiom Lumen',
  },
  description:
    'Axiom Lumen aggregates, cross-checks, and confidence-scores Stellar network data — reconciling Horizon, Archive, DEX, and anchor sources into one verified answer.',
  icons: {
    icon: '/favicon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0B1B33',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${plexSans.variable} ${plexMono.variable} bg-navy`}
    >
      <body className="bg-navy text-ink antialiased">
        <Nav />
        {children}
        <Footer />
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
