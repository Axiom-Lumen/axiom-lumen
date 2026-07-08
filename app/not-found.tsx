import { Wrap, Kicker, ButtonPrimary, ButtonSecondary, CodePanel, K, S } from '@/components/site'

export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] items-center py-24">
      <Wrap className="w-full">
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3 border-b border-linesoft pb-4">
          <Kicker color="cyan">Error 404</Kicker>
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-dim">
            AL-ERR-404
          </div>
        </div>
        <h1 className="mt-10 max-w-[820px] text-balance font-serif text-[clamp(38px,5.4vw,72px)] font-medium leading-[1.04] tracking-[-0.015em]">
          No verified match for this path.
        </h1>
        <p className="mt-7 max-w-[560px] text-[17px] leading-relaxed text-muted">
          We checked every source we have. The page you requested does not exist at this address —
          confidence 1.0.
        </p>
        <CodePanel label="Lookup result" className="mt-10 max-w-[560px]">
          <code>
            {'{ '}
            <K>{'"status"'}</K>
            {': '}
            <S>{'"not_found"'}</S>
            {', '}
            <K>{'"sources_agreeing"'}</K>
            {': '}
            <span className="text-ink">{'"all"'}</span>
            {' }'}
          </code>
        </CodePanel>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <ButtonPrimary href="/">Return to a known state</ButtonPrimary>
          <ButtonSecondary href="/docs">Browse the docs</ButtonSecondary>
        </div>
      </Wrap>
    </main>
  )
}
