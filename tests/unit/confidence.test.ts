import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  computeAvailabilityScore,
  computeSourceClassDiversity,
  computeWeightedAgreement,
} from '../../lib/reconcile/agreement'
import {
  CONFIDENCE_COMPONENT_KEYS,
  computeConfidence,
  type ConfidenceComponents,
} from '../../lib/reconcile/confidence'
import { computeNormalizedSpread } from '../../lib/reconcile/spread'

const coefficients = { agreement: 0.5, freshness: 0.25, availability: 0.2, spread: 0.05 }
const unitInterval = fc.double({ min: 0, max: 1, noNaN: true })
const componentsArbitrary = fc.record({
  agreement: unitInterval,
  freshness: unitInterval,
  availability: unitInterval,
  diversity: unitInterval,
  spread: unitInterval,
})

describe('agreement and diversity', () => {
  it('calculates agreement by effective weight rather than source count', () => {
    expect(
      computeWeightedAgreement([
        { effectiveWeight: 3, agrees: true },
        { effectiveWeight: 1, agrees: false },
      ]),
    ).toEqual({ score: 0.75, agreeingWeight: 3, totalWeight: 4 })
  })

  it('calculates availability and expected source-class coverage', () => {
    expect(computeAvailabilityScore({ usableSources: 3, configuredSources: 4 })).toBe(0.75)
    expect(
      computeSourceClassDiversity({
        representedSourceClasses: ['canonical_ledger', 'canonical_ledger', 'archive'],
        expectedSourceClasses: ['canonical_ledger', 'archive', 'third_party_oracle'],
      }),
    ).toEqual({
      score: 2 / 3,
      representedClasses: ['archive', 'canonical_ledger'],
      expectedClasses: ['archive', 'canonical_ledger', 'third_party_oracle'],
    })
  })
})

describe('normalized spread', () => {
  it('uses the largest absolute distance and saturates at the configured maximum', () => {
    const result = computeNormalizedSpread({ distances: [-1, 2, 4], maximumDistance: 5 })
    expect(result.maximumObservedDistance).toBe(4)
    expect(result.normalizedSpread).toBe(0.8)
    expect(result.score).toBeCloseTo(0.2)
    expect(computeNormalizedSpread({ distances: [20], maximumDistance: 5 }).score).toBe(0)
  })
})

describe('versioned confidence', () => {
  it('matches the documented worked example', () => {
    const result = computeConfidence({
      formulaVersion: 'worked-example-v1',
      components: {
        agreement: 0.8,
        freshness: 0.9,
        availability: 0.75,
        diversity: 0.5,
        spread: 0.6,
      },
      coefficients,
    })

    expect(result.uncappedScore).toBeCloseTo(0.4025)
    expect(result.score).toBe(0.4025)
    expect(result.formulaVersion).toBe('worked-example-v1')
  })

  it('applies active caps in policy order and reports only caps that lower the score', () => {
    const result = computeConfidence({
      formulaVersion: 'caps-v1',
      components: { agreement: 1, freshness: 1, availability: 1, diversity: 1, spread: 1 },
      coefficients,
      caps: [
        { id: 'source_error', maximum: 0.85, applies: true },
        { id: 'single_source', maximum: 0.6, applies: true },
        { id: 'inactive', maximum: 0.1, applies: false },
      ],
    })

    expect(result.score).toBe(0.6)
    expect(result.capsApplied).toEqual(['source_error', 'single_source'])
  })

  it('is finite and bounded for generated valid component combinations', () => {
    fc.assert(
      fc.property(componentsArbitrary, (components) => {
        const result = computeConfidence({ formulaVersion: 'property-v1', components, coefficients })
        expect(Number.isFinite(result.score)).toBe(true)
        expect(result.score).toBeGreaterThanOrEqual(0)
        expect(result.score).toBeLessThanOrEqual(1)
      }),
    )
  })

  it('never decreases when any component improves and all other inputs are fixed', () => {
    fc.assert(
      fc.property(
        componentsArbitrary,
        fc.constantFrom(...CONFIDENCE_COMPONENT_KEYS),
        unitInterval,
        (components, key, candidate) => {
          const improved: ConfidenceComponents = { ...components, [key]: Math.max(components[key], candidate) }
          const before = computeConfidence({ formulaVersion: 'property-v1', components, coefficients }).score
          const after = computeConfidence({ formulaVersion: 'property-v1', components: improved, coefficients }).score
          expect(after).toBeGreaterThanOrEqual(before)
        },
      ),
    )
  })
})
