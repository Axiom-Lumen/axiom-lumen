export interface NormalizedSpreadResult {
  score: number
  maximumObservedDistance: number
  normalizedSpread: number
}

/** Converts the largest absolute distance from the reference into a bounded inverse spread score. */
export function computeNormalizedSpread({
  distances,
  maximumDistance,
}: {
  distances: readonly number[]
  maximumDistance: number
}): NormalizedSpreadResult {
  if (!Number.isFinite(maximumDistance) || maximumDistance <= 0) {
    throw new Error('maximumDistance must be a finite number greater than zero')
  }

  const maximumObservedDistance = distances.reduce((maximum, distance, index) => {
    if (!Number.isFinite(distance)) {
      throw new Error(`distances[${index}] must be finite`)
    }
    return Math.max(maximum, Math.abs(distance))
  }, 0)
  const normalizedSpread = Math.min(1, maximumObservedDistance / maximumDistance)

  return {
    score: 1 - normalizedSpread,
    maximumObservedDistance,
    normalizedSpread,
  }
}
