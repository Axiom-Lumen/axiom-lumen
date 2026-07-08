import { Wrap } from "@/components/site"




export function ReconciliationStrip() {
  const readings = [
    { source: 'horizon', value: '48,213,092.44', state: 'ok' },
    { source: 'archive', value: '48,213,090.11', state: 'ok' },
    { source: 'anchor_api', value: '48,198,211.00', state: 'flag' },
  ]
  return (
    <div className="border-y border-line bg-deep">
      <Wrap>
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1 pt-5 font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block size-1.5 rounded-full bg-cyan [animation:pulse-dot_2s_infinite]"
            />
            Live reconciliation — USDC circulating supply
          </span>
          <span>as of 14:22:01 UTC</span>
        </div>
        <div className="grid gap-x-0 gap-y-6 py-7 sm:grid-cols-[1fr_1fr_1fr_auto] sm:gap-y-0">
          {readings.map((r) => (
            <div key={r.source} className="sm:border-r sm:border-linesoft sm:pr-8 sm:[&:not(:first-child)]:pl-8">
              <div
                className={`font-mono text-[11px] uppercase tracking-[0.1em] ${
                  r.state === 'flag' ? 'text-danger' : 'text-dim'
                }`}
              >
                {r.source}
                {r.state === 'flag' && ' · deviation'}
              </div>
              <div
                className={`mt-2 font-mono text-[17px] tabular-nums ${
                  r.state === 'flag' ? 'text-danger' : 'text-muted'
                }`}
              >
                {r.value}
              </div>
            </div>
          ))}
          <div className="sm:pl-8">
            <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-gold">
              verified · 0.94 confidence
            </div>
            <div className="mt-2 font-serif text-[26px] font-medium leading-none tabular-nums text-gold">
              48,213,091.02
            </div>
          </div>
        </div>
      </Wrap>
    </div>
  )
}