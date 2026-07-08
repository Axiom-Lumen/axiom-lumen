// components/hero.tsx
//
// Adjust the import paths below to match your actual file structure if they
// differ — I've assumed a flat components/ directory with a @ alias to match
// the pattern implied by your nav.tsx / footer.tsx setup. lib/doc-codes.ts
// is the constants file from the previous fix; create it if you haven't yet.
import { DOC_CODES } from "@/lib/doc-codes";
import { ArrowLink, ButtonPrimary, Kicker, Wrap } from "../../site";
import { ReconciliationStrip } from "./reconiclation-strip";

export function Hero() {
  return (
    <section className="pt-16 sm:pt-24">
      <Wrap>
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3 border-b border-linesoft pb-4">
          <Kicker color="cyan">Verification layer · Stellar network</Kicker>
          <div
            aria-hidden="true"
            className="font-mono text-[11px] uppercase tracking-[0.14em] text-dim"
          >
            {DOC_CODES.home}
          </div>
        </div>

        <h1 className="mt-12 font-serif text-[clamp(44px,8vw,110px)] font-medium leading-[0.98] tracking-[-0.02em]">
          Every Stellar data point, <em className="italic text-gold">cross-checked</em>{" "}
          <span className="text-muted">before you trust it.</span>
        </h1>

        <div className="mt-12 grid gap-x-12 gap-y-8 pb-16 md:grid-cols-[128px_minmax(0,1fr)]">
          <div aria-hidden="true" className="hidden md:block" />
          <div className="flex max-w-[820px] flex-col gap-8 md:flex-row md:items-end md:justify-between">
            <p className="max-w-[460px] text-[16px] leading-relaxed text-muted">
              Axiom Lumen aggregates Horizon, Archive, DEX, and anchor data, reconciles the
              discrepancies between them, and hands you one confidence-scored answer — not five
              conflicting ones.
            </p>
            <div className="flex shrink-0 flex-wrap md:flex-nowrap items-center gap-6">
              <ButtonPrimary className='w-full md:w-auto text-center' href="/pricing">Get API access</ButtonPrimary>
              <ArrowLink className='w-full md:w-auto justify-center text-center' href="/methodology">Methodology</ArrowLink>
            </div>
          </div>
        </div>
      </Wrap>
      <ReconciliationStrip />
    </section>
  );
}