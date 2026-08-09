export type TimestampBasis = 'source' | 'retrieved'

export interface TimestampSelection {
  timestamp: string
  timestampMs: number
  basis: TimestampBasis
}

export interface EffectiveWeightResult extends TimestampSelection {
  ageSeconds: number
  effectiveWeight: number
}

function parseTimestamp(value: string | null | undefined) {
  if (!value) return null
  const timestampMs = Date.parse(value)
  if (!Number.isFinite(timestampMs)) return null
  return { timestamp: new Date(timestampMs).toISOString(), timestampMs }
}

/** Prefer a valid source timestamp and fall back to the retrieval timestamp. */
export function selectObservationTimestamp({
  sourceTimestamp,
  retrievedAt,
}: {
  sourceTimestamp?: string | null
  retrievedAt: string
}): TimestampSelection {
  const source = parseTimestamp(sourceTimestamp)
  if (source) return { ...source, basis: 'source' }

  const retrieved = parseTimestamp(retrievedAt)
  if (retrieved) return { ...retrieved, basis: 'retrieved' }

  throw new Error('observation requires a valid source or retrieval timestamp')
}

export function computeAgeSeconds({ timestampMs, now }: { timestampMs: number; now: Date }) {
  const nowMs = now.getTime()
  if (!Number.isFinite(timestampMs)) throw new Error('timestampMs must be finite')
  if (!Number.isFinite(nowMs)) throw new Error('now must be a valid date')
  return Math.max(0, (nowMs - timestampMs) / 1000)
}

/** Computes exponential half-life decay from an already-derived non-negative age. */
export function computeWeightFromAge({
  baseWeight,
  ageSeconds,
  halfLifeSeconds,
}: {
  baseWeight: number
  ageSeconds: number
  halfLifeSeconds: number
}) {
  if (!Number.isFinite(baseWeight) || baseWeight < 0) {
    throw new Error('baseWeight must be a finite non-negative number')
  }
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) {
    throw new Error('ageSeconds must be a finite non-negative number')
  }
  if (!Number.isFinite(halfLifeSeconds) || halfLifeSeconds <= 0) {
    throw new Error('halfLifeSeconds must be a finite number greater than zero')
  }
  if (baseWeight === 0) return 0
  return baseWeight * 0.5 ** (ageSeconds / halfLifeSeconds)
}

export function computeEffectiveWeight({
  baseWeight,
  sourceTimestamp,
  retrievedAt,
  now,
  halfLifeSeconds,
}: {
  baseWeight: number
  sourceTimestamp?: string | null
  retrievedAt: string
  now: Date
  halfLifeSeconds: number
}): EffectiveWeightResult {
  const selected = selectObservationTimestamp({ sourceTimestamp, retrievedAt })
  const ageSeconds = computeAgeSeconds({ timestampMs: selected.timestampMs, now })
  const effectiveWeight = computeWeightFromAge({ baseWeight, ageSeconds, halfLifeSeconds })
  return { ...selected, ageSeconds, effectiveWeight }
}
