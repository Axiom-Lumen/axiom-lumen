import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { computeSafeIntegerWeightedMedian } from '../../lib/reconcile/weighted-median'

const inputs = fc.uniqueArray(
  fc.record({
    id: fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/),
    value: fc.integer({ min: -1_000_000, max: 1_000_000 }),
    effectiveWeight: fc.integer({ min: 0, max: 100 }),
  }),
  { minLength: 1, maxLength: 30, selector: (input) => input.id },
)

describe('reconciliation properties', () => {
  it('is invariant under input ordering and never mutates observations', () => {
    fc.assert(fc.property(inputs, fc.integer(), (observations, seed) => {
      const before = structuredClone(observations)
      const shuffled = fc.sample(fc.shuffledSubarray(observations, {
        minLength: observations.length,
        maxLength: observations.length,
      }), { seed, numRuns: 1 })[0]!

      expect(computeSafeIntegerWeightedMedian(shuffled)).toEqual(computeSafeIntegerWeightedMedian(observations))
      expect(observations).toEqual(before)
    }))
  })

  it('selects a contributing value with at least half the weight on or above and on or below', () => {
    fc.assert(fc.property(inputs, (observations) => {
      const result = computeSafeIntegerWeightedMedian(observations)
      const contributors = observations.filter((input) => input.effectiveWeight > 0)
      if (contributors.length === 0) {
        expect(result).toBeNull()
        return
      }

      expect(contributors.some((input) => input.id === result?.selectedId)).toBe(true)
      const atOrBelow = contributors
        .filter((input) => input.value <= result!.value)
        .reduce((total, input) => total + input.effectiveWeight, 0)
      const atOrAbove = contributors
        .filter((input) => input.value >= result!.value)
        .reduce((total, input) => total + input.effectiveWeight, 0)
      expect(atOrBelow).toBeGreaterThanOrEqual(result!.totalWeight / 2)
      expect(atOrAbove).toBeGreaterThanOrEqual(result!.totalWeight / 2)
    }))
  })
})
