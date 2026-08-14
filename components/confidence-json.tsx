import React, { Suspense, type ReactNode } from 'react'
import {
  createIllustrativeSupplyArtifact,
  type ConfidenceArtifactState,
} from '../lib/home/confidence-artifact'
import { loadSiteConfidenceArtifact } from '../lib/home/site-confidence-artifact'

export function K({ children }: { children: ReactNode }) {
  return <span className="text-cyan">{children}</span>
}

export function S({ children }: { children: ReactNode }) {
  return <span className="text-gold">{children}</span>
}

export function highlightJson(value: unknown, indent = 0): ReactNode {
  const spaces = ' '.repeat(indent)

  if (value === null) return <span className="text-dim">null</span>
  if (typeof value === 'string') return <span className="text-gold">{JSON.stringify(value)}</span>
  if (typeof value === 'number') return <span>{value}</span>
  if (typeof value === 'boolean') return <span className="text-gold">{String(value)}</span>

  if (Array.isArray(value)) {
    if (value.length === 0) return <span>[]</span>
    return (
      <>
        {'[\n'}
        {value.map((item, index) => (
          <React.Fragment key={index}>
            {' '.repeat(indent + 2)}
            {highlightJson(item, indent + 2)}
            {index === value.length - 1 ? '' : ','}
            {'\n'}
          </React.Fragment>
        ))}
        {spaces}{']'}
      </>
    )
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return <span>{'{}'}</span>
    return (
      <>
        {'{\n'}
        {entries.map(([key, entry], index) => (
          <React.Fragment key={key}>
            {' '.repeat(indent + 2)}
            <span className="text-cyan">{JSON.stringify(key)}</span>
            {': '}
            {highlightJson(entry, indent + 2)}
            {index === entries.length - 1 ? '' : ','}
            {'\n'}
          </React.Fragment>
        ))}
        {spaces}{'}'}
      </>
    )
  }

  return <span>{String(value)}</span>
}

export function DataArtifactEmpty({
  children,
  label = 'Illustrative example — no live snapshot',
  pending = false,
}: {
  children: ReactNode
  label?: string
  pending?: boolean
}) {
  return (
    <figure
      className="relative overflow-hidden rounded-sm border border-dashed border-golddim/40 opacity-85"
      data-artifact-state={pending ? 'loading' : 'not-live'}
    >
      <figcaption className="flex items-center justify-between border-b border-dashed border-golddim/40 bg-surface/50 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-golddim">
        <span role="status" aria-live="polite" aria-atomic="true">{label}</span>
        <span aria-hidden="true" className={pending ? 'animate-pulse text-golddim' : 'text-golddim'}>
          ○
        </span>
      </figcaption>
      <pre className="overflow-x-auto bg-deep/80 p-5 font-mono text-[12.5px] leading-[1.7] text-muted/80 sm:p-6">
        <code>{children}</code>
      </pre>
    </figure>
  )
}

function DataArtifactLive({ children, label }: { children: ReactNode; label: string }) {
  return (
    <figure className="overflow-hidden rounded-sm" data-artifact-state="live">
      <figcaption className="flex items-center justify-between border border-b-0 border-linesoft bg-surface px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
        <span role="status" aria-live="polite" aria-atomic="true">{label}</span>
        <span aria-hidden="true" className="text-gold">●</span>
      </figcaption>
      <pre className="overflow-x-auto border border-linesoft bg-deep p-5 font-mono text-[12.5px] leading-[1.7] text-muted sm:p-6">
        <code>{children}</code>
      </pre>
    </figure>
  )
}

export function ConfidenceJsonLoading() {
  return (
    <DataArtifactEmpty label="Loading live supply snapshot" pending>
      <span>Requesting and validating the current API response…</span>
    </DataArtifactEmpty>
  )
}

export function ConfidenceArtifactView({ state }: { state: ConfidenceArtifactState }) {
  if (state.kind === 'verified' || state.kind === 'degraded') {
    return (
      <DataArtifactLive label={`Live ${state.kind} supply snapshot`}>
        {highlightJson(state.snapshot)}
      </DataArtifactLive>
    )
  }

  if (state.kind === 'stale') {
    return (
      <DataArtifactEmpty label="Stale supply snapshot — not current">
        {highlightJson(state.snapshot)}
      </DataArtifactEmpty>
    )
  }

  if (state.kind === 'unavailable') {
    return (
      <DataArtifactEmpty label="Current supply endpoint state — unavailable">
        {highlightJson(state.response)}
      </DataArtifactEmpty>
    )
  }

  const label = state.kind === 'empty'
    ? 'Illustrative example — no live snapshot'
    : 'Illustrative example — live response unavailable'
  return (
    <DataArtifactEmpty label={label}>
      {highlightJson(createIllustrativeSupplyArtifact(state.asset))}
    </DataArtifactEmpty>
  )
}

async function ConfidenceJsonContent({
  load,
}: {
  load: () => Promise<ConfidenceArtifactState>
}) {
  return <ConfidenceArtifactView state={await load()} />
}

export function ConfidenceJson({
  load = loadSiteConfidenceArtifact,
}: {
  load?: () => Promise<ConfidenceArtifactState>
} = {}) {
  return (
    <Suspense fallback={<ConfidenceJsonLoading />}>
      <ConfidenceJsonContent load={load} />
    </Suspense>
  )
}
