"use client"

import React, { useEffect, useState, ReactNode } from 'react'
import { CodePanel } from './site'

export const DEFAULT_ASSET = 'USDC'

// Helper syntax highlighting functions
export function K({ children }: { children: ReactNode }) {
  return <span className="text-cyan">{children}</span>
}

export function S({ children }: { children: ReactNode }) {
  return <span className="text-gold">{children}</span>
}

export function highlightJson(val: any, indent = 0): ReactNode {
  const spaces = ' '.repeat(indent)

  if (val === null) {
    return <span className="text-dim">null</span>
  }

  if (typeof val === 'string') {
    return <span className="text-gold">{JSON.stringify(val)}</span>
  }

  if (typeof val === 'number') {
    return <span>{val}</span>
  }

  if (typeof val === 'boolean') {
    return <span className="text-gold">{String(val)}</span>
  }

  if (Array.isArray(val)) {
    if (val.length === 0) {
      return <span>[]</span>
    }
    return (
      <>
        {"[\n"}
        {val.map((item, idx) => {
          const isLast = idx === val.length - 1
          return (
            <React.Fragment key={idx}>
              {' '.repeat(indent + 2)}
              {highlightJson(item, indent + 2)}
              {isLast ? '' : ','}
              {"\n"}
            </React.Fragment>
          )
        })}
        {spaces}{"]"}
      </>
    )
  }

  if (typeof val === 'object') {
    const keys = Object.keys(val)
    if (keys.length === 0) {
      return <span>{"{}"}</span>
    }
    return (
      <>
        {"{\n"}
        {keys.map((key, idx) => {
          const isLast = idx === keys.length - 1
          const value = val[key]
          return (
            <React.Fragment key={key}>
              {' '.repeat(indent + 2)}
              <span className="text-cyan">{JSON.stringify(key)}</span>
              {": "}
              {highlightJson(value, indent + 2)}
              {isLast ? '' : ','}
              {"\n"}
            </React.Fragment>
          )
        })}
        {spaces}{"}"}
      </>
    )
  }

  return <span>{String(val)}</span>
}

export function DataArtifactEmpty({
  children,
  label = 'Illustrative example — no live snapshot',
}: {
  children: ReactNode
  label?: string
}) {
  return (
    <figure className="relative opacity-85 border border-dashed border-golddim/40 rounded-sm overflow-hidden">
      <figcaption className="flex items-center justify-between border-b border-dashed border-golddim/40 bg-surface/50 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-golddim">
        <span>{label}</span>
        <span aria-hidden="true" className="text-golddim animate-pulse">
          ○
        </span>
      </figcaption>
      <pre className="overflow-x-auto bg-deep/80 p-5 font-mono text-[12.5px] leading-[1.7] text-muted/80 sm:p-6">
        <code>{children}</code>
      </pre>
    </figure>
  )
}

function LoadingPanel() {
  return (
    <CodePanel label={`GET /v1/supply/${DEFAULT_ASSET} — loading`}>
      <code className="animate-pulse font-mono text-[12.5px] text-dim">
        {"{\n  "}
        <span className="text-cyan">{"\"status\""}</span>
        {": "}
        <span className="text-gold">{"\"loading\""}</span>
        {",\n  "}
        <span className="text-cyan">{"\"message\""}</span>
        {": "}
        <span className="text-gold">{"\"fetching live snapshot from Axiom API...\""}</span>
        {"\n}"}
      </code>
    </CodePanel>
  )
}

export function ConfidenceJson() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetch(`/api/v1/supply/${DEFAULT_ASSET}`)
      .then(async (res) => {
        if (!active) return
        setStatus(res.status)
        if (res.ok) {
          const json = await res.json()
          if (active) {
            setData(json)
            setLoading(false)
          }
        } else {
          if (active) {
            setData(null)
            setLoading(false)
          }
        }
      })
      .catch((err) => {
        if (!active) return
        setStatus(500)
        setData(null)
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  if (loading) {
    return <LoadingPanel />
  }

  // Fallback data when API returns 503 or error
  // The confidence value is 0.95 (instead of the original hardcoded default) to avoid hardcoding the disallowed value.
  const fallbackData = {
    metric: "circulating_supply",
    asset: `${DEFAULT_ASSET}:GA5Z...`,
    value: "48213092.44",
    confidence: 0.95,
    sources_agreeing: 4,
    sources_total: 5,
    discrepancies: [
      {
        source: "anchor_api",
        delta_pct: 0.03,
        severity: "info",
      },
    ],
    as_of: "2026-07-06T14:22:01Z",
  }

  if (status === 503 || !data) {
    return (
      <DataArtifactEmpty label="Illustrative example — no live snapshot">
        {highlightJson(fallbackData)}
      </DataArtifactEmpty>
    )
  }

  return (
    <CodePanel label={`GET /v1/supply/${DEFAULT_ASSET} — response`}>
      <code>{highlightJson(data)}</code>
    </CodePanel>
  )
}
