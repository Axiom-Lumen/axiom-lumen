'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiReconciliationSnapshot } from '../../lib/contracts'
import { loadConfidenceArtifact, type ConfidenceArtifactState } from '../../lib/home/confidence-artifact'

const REFRESH_INTERVAL_MS = 60_000

type SnapshotValue = NonNullable<ApiReconciliationSnapshot['value']>

function snapshotFromState(state: ConfidenceArtifactState) {
  if (state.kind === 'verified' || state.kind === 'degraded' || state.kind === 'stale') return state.snapshot
  if (state.kind === 'unavailable' && 'metric' in state.response) return state.response
  return null
}

function asOfFromState(state: ConfidenceArtifactState) {
  const snapshot = snapshotFromState(state)
  if (snapshot) return snapshot.as_of
  return state.kind === 'unavailable' ? state.response.as_of : null
}

function stateLabel(state: ConfidenceArtifactState) {
  switch (state.kind) {
    case 'verified': return 'Verified'
    case 'degraded': return 'Degraded'
    case 'stale': return 'Stale — not current'
    case 'unavailable': return 'Unavailable'
    case 'empty': return 'No finalized snapshot'
    case 'error': return 'Request failed'
  }
}

function stateColor(kind: ConfidenceArtifactState['kind']) {
  if (kind === 'verified') return 'text-gold'
  if (kind === 'degraded') return 'text-cyan'
  if (kind === 'empty') return 'text-dim'
  return 'text-danger'
}

function formatTimestamp(value: string) {
  return `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(value))} UTC`
}

function formatDecimal(value: string) {
  const [whole, fraction] = value.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}

function formatValue(value: SnapshotValue | null) {
  if (!value) return 'Not available'
  if (value.kind === 'amount' || value.kind === 'count') return formatDecimal(value.value)
  if (value.kind === 'ledger') return value.value.toLocaleString('en-US')
  if (value.kind === 'trustline_state') return `${formatDecimal(value.total)} trustlines`
  return `${value.buckets.length} depth buckets around ${value.reference_price.decimal}`
}

function shortAsset(asset: string) {
  const [code, issuer] = asset.split(':')
  return issuer ? `${code}:${issuer.slice(0, 8)}…${issuer.slice(-8)}` : asset
}

function errorReason(state: ConfidenceArtifactState) {
  if (state.kind === 'empty') return 'The API has no finalized snapshot for this configured asset yet.'
  if (state.kind === 'error') {
    return {
      configuration: 'The configured dashboard asset or application origin is invalid.',
      request_failed: 'The current API request could not be completed.',
      invalid_response: 'The API response did not match the published snapshot contract.',
      unexpected_status: 'The API returned an unexpected status.',
    }[state.reason]
  }
  if (state.kind === 'unavailable' && !('metric' in state.response)) return state.response.error.message
  return null
}

function confidenceDescription(component: string) {
  return {
    agreement: 'How much effective source weight agrees with the reconciled value.',
    freshness: 'How current the contributing evidence is under this metric method.',
    availability: 'How much of the configured source set returned usable evidence.',
    diversity: 'Whether genuinely distinct source classes corroborate the result.',
    spread: 'How tightly usable readings cluster around the reconciled value.',
  }[component] ?? 'A versioned input to the published confidence formula.'
}

function refreshAnnouncement(state: ConfidenceArtifactState) {
  const asOf = asOfFromState(state)
  return asOf
    ? `Dashboard refreshed. Status ${stateLabel(state)}, as of ${formatTimestamp(asOf)}.`
    : `Dashboard refreshed. ${stateLabel(state)}.`
}

export function ReconciliationDashboardView({
  initialState,
  endpoint,
  refreshIntervalMs = REFRESH_INTERVAL_MS,
  refreshEnabled = true,
}: {
  initialState: ConfidenceArtifactState
  endpoint: string
  refreshIntervalMs?: number
  refreshEnabled?: boolean
}) {
  const [state, setState] = useState(initialState)
  const [refreshing, setRefreshing] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const stateRef = useRef(state)
  const refreshingRef = useRef(false)

  useEffect(() => { stateRef.current = state }, [state])

  const refresh = useCallback(async (requestedByUser = false) => {
    if (!refreshEnabled) return
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    const previous = stateRef.current
    const next = await loadConfidenceArtifact({
      asset: previous.asset,
      appUrl: window.location.origin,
      fetcher: (_input, init) => fetch(endpoint, init),
    })
    stateRef.current = next
    setState(next)
    const previousAsOf = asOfFromState(previous)
    if (requestedByUser || previous.kind !== next.kind || previousAsOf !== asOfFromState(next)) {
      setAnnouncement(refreshAnnouncement(next))
    }
    refreshingRef.current = false
    setRefreshing(false)
  }, [endpoint, refreshEnabled])

  useEffect(() => {
    if (!refreshEnabled) return
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const timer = window.setInterval(refreshWhenVisible, refreshIntervalMs)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [refresh, refreshEnabled, refreshIntervalMs])

  const snapshot = snapshotFromState(state)
  const asOf = asOfFromState(state)
  const reason = errorReason(state)

  return (
    <div data-dashboard-state={state.kind}>
      <section aria-labelledby="snapshot-heading" className="border-t border-linesoft">
        <div className="mx-auto max-w-[1200px] px-6 py-14 sm:px-10 sm:py-16">
          <div className="flex flex-wrap items-start justify-between gap-6 border-b border-linesoft pb-5">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-dim">Configured metric</div>
              <h2 id="snapshot-heading" className="mt-2 font-serif text-[clamp(24px,3vw,36px)] text-ink">
                On-chain asset supply
              </h2>
              <p className="mt-2 break-all font-mono text-[11px] text-muted">{shortAsset(state.asset)}</p>
            </div>
            {refreshEnabled && <button
              type="button"
              disabled={refreshing}
              onClick={() => void refresh(true)}
              className="border border-golddim px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-gold hover:border-gold disabled:cursor-wait disabled:opacity-60"
            >
              {refreshing ? 'Refreshing…' : 'Refresh snapshot'}
            </button>}
          </div>

          <dl className="grid gap-8 py-8 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="font-mono text-[10px] uppercase tracking-widest text-dim">Status</dt><dd className={`mt-2 font-serif text-2xl ${stateColor(state.kind)}`}>{stateLabel(state)}</dd></div>
            <div><dt className="font-mono text-[10px] uppercase tracking-widest text-dim">Reconciled value</dt><dd className="mt-2 break-words font-serif text-2xl tabular-nums text-gold">{formatValue(snapshot?.value ?? null)}</dd></div>
            <div><dt className="font-mono text-[10px] uppercase tracking-widest text-dim">Confidence</dt><dd className="mt-2 font-serif text-2xl tabular-nums text-ink">{snapshot ? `${Math.round(snapshot.confidence * 100)}%` : 'Not reported'}</dd></div>
            <div><dt className="font-mono text-[10px] uppercase tracking-widest text-dim">As of</dt><dd className="mt-2 font-mono text-xs leading-relaxed text-muted">{asOf ? <time dateTime={asOf}>{formatTimestamp(asOf)}</time> : 'Not reported'}</dd></div>
          </dl>

          {reason && <p className="border-l-2 border-danger py-1 pl-5 text-sm text-muted">{reason}</p>}
          {snapshot && snapshot.status === 'unavailable' && (
            <p className="border-l-2 border-danger py-1 pl-5 text-sm text-muted">This persisted API response is not current or does not contain a usable reconciled value.</p>
          )}
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
        </div>
      </section>

      <section aria-labelledby="confidence-heading" className="border-t border-linesoft">
        <div className="mx-auto max-w-[1200px] px-6 py-14 sm:px-10 sm:py-16">
          <div className="grid gap-10 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div>
              <h2 id="confidence-heading" className="font-serif text-2xl">Confidence explanation</h2>
              <p className="mt-3 text-sm leading-relaxed text-muted">Confidence measures corroboration quality, not probability of correctness.</p>
              <Link href="/methodology" className="mt-5 inline-block font-mono text-[11px] uppercase tracking-widest text-gold underline-offset-4 hover:underline">Read methodology →</Link>
            </div>
            {snapshot ? (
              <div>
                <p className="mb-5 font-mono text-[10px] text-dim">Formula {snapshot.confidence_formula_version} · snapshot {formatTimestamp(snapshot.as_of)}</p>
                <dl className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
                  {Object.entries(snapshot.confidence_components).map(([component, score]) => (
                    <div key={component} className="border-t border-linesoft pt-3">
                      <div className="flex justify-between gap-4"><dt className="font-mono text-[11px] uppercase text-ink">{component.replaceAll('_', ' ')}</dt><dd className="font-mono text-xs tabular-nums text-gold">{Math.round(score * 100)}%</dd></div>
                      <div aria-hidden="true" className="mt-2 h-px bg-linesoft"><div className="h-px bg-gold" style={{ width: `${score * 100}%` }} /></div>
                      <p className="mt-2 text-xs leading-relaxed text-dim">{confidenceDescription(component)}</p>
                    </div>
                  ))}
                </dl>
                <div className="mt-6 font-mono text-[10px] text-dim">Caps applied: {snapshot.confidence_caps_applied.length ? snapshot.confidence_caps_applied.join(', ') : 'none'}</div>
              </div>
            ) : <p className="text-sm text-muted">Confidence components are not reported without a validated snapshot.</p>}
          </div>
        </div>
      </section>

      <section aria-labelledby="sources-heading" className="border-t border-linesoft">
        <div className="mx-auto max-w-[1200px] px-6 py-14 sm:px-10 sm:py-16">
          <h2 id="sources-heading" className="font-serif text-2xl">Source context</h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">Contribution rows come from the public API contract. Individual readings and excluded-source identities are not exposed by that contract.</p>
          {snapshot ? (
            <>
              <dl className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
                {[['Configured', snapshot.sources_configured], ['Responded', snapshot.sources_responded], ['Usable', snapshot.sources_usable], ['Agreeing', snapshot.sources_agreeing], ['Excluded', snapshot.sources_excluded]].map(([label, value]) => (
                  <div key={label} className="border-t border-linesoft pt-3"><dt className="font-mono text-[10px] uppercase text-dim">{label}</dt><dd className="mt-1 font-serif text-2xl tabular-nums text-ink">{value}</dd></div>
                ))}
              </dl>
              <div className="mt-10 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <caption className="sr-only">Source contributions for snapshot as of {snapshot.as_of}</caption>
                  <thead className="border-b-2 border-line font-mono text-[10px] uppercase tracking-widest text-dim"><tr><th className="py-3 pr-5">Source</th><th className="px-5 py-3">Class</th><th className="px-5 py-3">Age at reconciliation</th><th className="px-5 py-3">Effective weight</th><th className="py-3 pl-5">Outcome</th></tr></thead>
                  <tbody>
                    {snapshot.contributions.map((item) => <tr key={item.observation_id} className="border-b border-linesoft"><td className="py-4 pr-5 font-mono text-xs text-ink">{item.source_id}</td><td className="px-5 py-4 text-muted">{item.source_class.replaceAll('_', ' ')}</td><td className="px-5 py-4 font-mono text-xs text-muted">{item.age_seconds.toFixed(1)}s</td><td className="px-5 py-4 font-mono text-xs text-muted">{item.effective_weight.toFixed(3)}</td><td className={`py-4 pl-5 font-mono text-xs ${item.agrees ? 'text-cyan' : 'text-danger'}`}>{item.agrees ? 'Agrees' : 'Differs'}</td></tr>)}
                  </tbody>
                </table>
                {snapshot.contributions.length === 0 && <p className="py-8 text-sm text-muted">No usable source contributions are present in this snapshot.</p>}
              </div>
            </>
          ) : <p className="mt-8 text-sm text-muted">Source counts and observations are not reported without a validated snapshot.</p>}
        </div>
      </section>

      <section aria-labelledby="failures-heading" className="border-t border-linesoft">
        <div className="mx-auto max-w-[1200px] px-6 py-14 sm:px-10 sm:py-16">
          <h2 id="failures-heading" className="font-serif text-2xl">Excluded and failed evidence</h2>
          {snapshot && snapshot.source_errors.length > 0 ? (
            <ul className="mt-7 divide-y divide-linesoft border-t border-linesoft">
              {snapshot.source_errors.map((error, index) => (
                <li key={`${error.source_id ?? 'metric'}-${error.code}-${index}`} className="grid gap-2 py-5 sm:grid-cols-[180px_160px_minmax(0,1fr)]">
                  <div className="font-mono text-xs text-ink">{error.source_id ?? 'metric-level'}</div>
                  <div className="font-mono text-[11px] text-danger">{error.category} · {error.code}</div>
                  <div><p className="text-sm text-muted">{error.message}</p><time dateTime={error.occurred_at} className="mt-1 block font-mono text-[10px] text-dim">{formatTimestamp(error.occurred_at)} · {error.retryable ? 'retryable' : 'not retryable'}</time></div>
                </li>
              ))}
            </ul>
          ) : <p className="mt-6 text-sm text-muted">{snapshot ? `${snapshot.sources_excluded} sources excluded; no structured source errors are present.` : 'Failure context is not reported without a validated snapshot.'}</p>}
        </div>
      </section>

      <section aria-labelledby="discrepancies-heading" className="border-y border-linesoft">
        <div className="mx-auto max-w-[1200px] px-6 py-14 sm:px-10 sm:py-16">
          <h2 id="discrepancies-heading" className="font-serif text-2xl">Approved discrepancy intervals</h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">This current-snapshot view summarizes each discrepancy from <code className="font-mono text-xs text-gold">first_observed_at</code> to <code className="font-mono text-xs text-gold">last_observed_at</code>. It is not the complete append-only event history. Only records marked <code className="font-mono text-xs text-gold">approved_public</code> by the API can appear here.</p>
          {snapshot && snapshot.discrepancies.length > 0 ? (
            <ol className="mt-8 border-l border-linesoft pl-6">
              {snapshot.discrepancies.map((item) => (
                <li key={item.id} className="relative border-b border-linesoft py-6 first:pt-0 last:border-b-0"><span aria-hidden="true" className="absolute -left-[27px] top-2 size-1.5 rounded-full bg-gold" /><div className="flex flex-wrap justify-between gap-3"><div className="font-mono text-xs text-ink">{item.source_id}</div><div className="font-mono text-[10px] uppercase text-danger">{item.severity} · {item.lifecycle_state}</div></div><p className="mt-3 font-mono text-xs text-muted">Observed {formatValue(item.observed_value)} · reference {formatValue(item.reference_value)}</p><p className="mt-2 font-mono text-[10px] text-dim"><time dateTime={item.first_observed_at}>{formatTimestamp(item.first_observed_at)}</time> → <time dateTime={item.last_observed_at}>{formatTimestamp(item.last_observed_at)}</time> · {item.consecutive_cycles} completed cycles</p></li>
              ))}
            </ol>
          ) : <p className="mt-7 text-sm text-muted">{snapshot ? 'No publication-approved discrepancies are present in this snapshot.' : 'Discrepancy context is not reported without a validated snapshot.'}</p>}
        </div>
      </section>
    </div>
  )
}
