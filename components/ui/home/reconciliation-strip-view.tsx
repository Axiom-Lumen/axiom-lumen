'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiReconciliationSnapshot } from '../../../lib/contracts'
import {
  loadConfidenceArtifact,
  type ConfidenceArtifactState,
} from '../../../lib/home/confidence-artifact'

export const RECONCILIATION_REFRESH_INTERVAL_MS = 60_000

function snapshotFromState(state: ConfidenceArtifactState): ApiReconciliationSnapshot | null {
  if (state.kind === 'verified' || state.kind === 'degraded' || state.kind === 'stale') {
    return state.snapshot
  }
  if (state.kind === 'unavailable' && 'metric' in state.response) return state.response
  return null
}

function asOfFromState(state: ConfidenceArtifactState) {
  const snapshot = snapshotFromState(state)
  if (snapshot) return snapshot.as_of
  if (state.kind === 'unavailable') return state.response.as_of
  return null
}

function stateLabel(state: ConfidenceArtifactState) {
  switch (state.kind) {
    case 'verified': return 'Verified live snapshot'
    case 'degraded': return 'Degraded live snapshot'
    case 'stale': return 'Stale snapshot — not current'
    case 'unavailable': return 'Current snapshot unavailable'
    case 'empty': return 'No finalized snapshot'
    case 'error': return 'Live snapshot could not be loaded'
  }
}

function stateTone(state: ConfidenceArtifactState) {
  if (state.kind === 'verified') return 'text-gold'
  if (state.kind === 'degraded') return 'text-cyan'
  if (state.kind === 'stale' || state.kind === 'unavailable' || state.kind === 'error') {
    return 'text-danger'
  }
  return 'text-dim'
}

function formatAmount(value: string) {
  const [whole, fraction] = value.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(value)) + ' UTC'
}

function shortAsset(asset: string) {
  const [code, issuer] = asset.split(':')
  return issuer ? `${code} · ${issuer.slice(0, 6)}…${issuer.slice(-6)}` : asset
}

function sourceSummary(snapshot: ApiReconciliationSnapshot | null) {
  if (!snapshot) return 'Not reported'
  return `${snapshot.sources_usable} usable / ${snapshot.sources_configured} configured`
}

function announcementFor(state: ConfidenceArtifactState) {
  const snapshot = snapshotFromState(state)
  return snapshot
    ? `${stateLabel(state)}, as of ${formatTimestamp(snapshot.as_of)}.`
    : `${stateLabel(state)}.`
}

export function ReconciliationStripView({
  initialState,
  endpoint,
  refreshIntervalMs = RECONCILIATION_REFRESH_INTERVAL_MS,
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

  useEffect(() => {
    stateRef.current = state
  }, [state])

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

    const previousSnapshot = snapshotFromState(previous)
    const nextSnapshot = snapshotFromState(next)
    const materialChange = previous.kind !== next.kind
      || previousSnapshot?.as_of !== nextSnapshot?.as_of
    if (requestedByUser || materialChange) setAnnouncement(announcementFor(next))

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
  const amount = snapshot?.value?.kind === 'amount' ? snapshot.value.value : null
  const status = stateLabel(state)

  return (
    <section
      aria-labelledby="reconciliation-strip-title"
      className="border-y border-line bg-deep"
      data-reconciliation-state={state.kind}
    >
      <div className="mx-auto max-w-[1200px] px-6 sm:px-10">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3 pt-5 font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
          <div>
            <h2 id="reconciliation-strip-title" className="text-inherit">
              On-chain asset supply reconciliation
            </h2>
            <div className="mt-1 normal-case tracking-normal text-muted">
              {shortAsset(state.asset)}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className={stateTone(state)}>{status}</span>
            {refreshEnabled && <button
              type="button"
              className="border-b border-dim pb-0.5 text-dim transition-colors hover:border-cyan hover:text-cyan disabled:cursor-wait disabled:opacity-60"
              disabled={refreshing}
              onClick={() => void refresh(true)}
            >
              {refreshing ? 'Refreshing…' : 'Refresh now'}
            </button>}
          </div>
        </div>

        <div className="grid gap-y-6 py-7 sm:grid-cols-2 lg:grid-cols-[1.35fr_0.8fr_0.8fr_1fr] lg:gap-y-0">
          <div className="min-w-0 sm:pr-8 lg:border-r lg:border-linesoft">
            <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-dim">
              Reconciled value
            </div>
            <div className={`mt-2 break-words font-serif text-[clamp(24px,3vw,34px)] font-medium leading-none tabular-nums ${amount ? 'text-gold' : 'text-muted'}`}>
              {amount ? formatAmount(amount) : 'Not available'}
            </div>
          </div>

          <div className="sm:border-l sm:border-linesoft sm:pl-8 lg:border-l-0">
            <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-dim">Confidence</div>
            <div className={`mt-2 font-serif text-[26px] font-medium leading-none tabular-nums ${stateTone(state)}`}>
              {snapshot ? `${Math.round(snapshot.confidence * 100)}%` : 'Not reported'}
            </div>
          </div>

          <div className="lg:border-l lg:border-linesoft lg:pl-8">
            <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-dim">Source context</div>
            <div className="mt-2 font-mono text-[13px] leading-snug text-muted">
              {sourceSummary(snapshot)}
            </div>
            {snapshot && (snapshot.sources_excluded > 0 || snapshot.source_errors.length > 0) && (
              <div className="mt-1 font-mono text-[10px] text-danger">
                {snapshot.sources_excluded} excluded · {snapshot.source_errors.length} errors
              </div>
            )}
          </div>

          <div className="sm:border-l sm:border-linesoft sm:pl-8">
            <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-dim">As of</div>
            <div className="mt-2 font-mono text-[12px] leading-snug text-muted">
              {asOf ? (
                <time dateTime={asOf}>{formatTimestamp(asOf)}</time>
              ) : 'Not reported'}
            </div>
          </div>
        </div>

        {snapshot && snapshot.contributions.length > 0 && (
          <details className="border-t border-linesoft py-4 text-sm text-muted">
            <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.12em] text-dim marker:text-golddim focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan">
              Source contributions ({snapshot.contributions.length})
            </summary>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {snapshot.contributions.map((contribution) => (
                <li key={contribution.observation_id} className="min-w-0 border-l border-linesoft pl-3">
                  <div className="truncate font-mono text-[11px] text-ink">{contribution.source_id}</div>
                  <div className="mt-1 font-mono text-[10px] text-dim">
                    {contribution.source_class.replaceAll('_', ' ')} · {contribution.agrees ? 'agrees' : 'differs'} · age {Math.round(contribution.age_seconds)}s
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-4 font-mono text-[10px] text-dim">
              Individual source values are omitted because the public contract exposes contribution metadata, not source readings.
            </p>
          </details>
        )}

        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
      </div>
    </section>
  )
}
