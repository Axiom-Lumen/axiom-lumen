import { describe, expect, it } from 'vitest'
import {
  computeSafeIntegerWeightedMedian,
  computeStellarAmountWeightedMedian,
} from '../../lib/reconcile/weighted-median'
import { parseStellarAmount } from '../../lib/stellar/amount'

describe('weighted median', () => {
  it('returns null when no positive-weight input exists', () => {
    expect(computeSafeIntegerWeightedMedian([])).toBeNull()
    expect(computeSafeIntegerWeightedMedian([{ id: 'zero', value: 10, effectiveWeight: 0 }])).toBeNull()
  })

  it('returns the only contributing value', () => {
    expect(
      computeSafeIntegerWeightedMedian([{ id: 'only', value: 42, effectiveWeight: 0.5 }]),
    ).toMatchObject({ value: 42, selectedId: 'only', totalWeight: 0.5, atIds: ['only'] })
  })

  it('selects the middle value for equal odd weights', () => {
    const result = computeSafeIntegerWeightedMedian([
      { id: 'high', value: 30, effectiveWeight: 1 },
      { id: 'low', value: 10, effectiveWeight: 1 },
      { id: 'middle', value: 20, effectiveWeight: 1 },
    ])

    expect(result).toMatchObject({
      value: 20,
      belowIds: ['low'],
      atIds: ['middle'],
      aboveIds: ['high'],
    })
  })

  it('uses the lower value when cumulative weight lands exactly at half', () => {
    const result = computeSafeIntegerWeightedMedian([
      { id: 'upper', value: 20, effectiveWeight: 1 },
      { id: 'lower', value: 10, effectiveWeight: 1 },
    ])

    expect(result?.value).toBe(10)
    expect(result?.selectedId).toBe('lower')
  })

  it('honors unequal effective weights', () => {
    const result = computeSafeIntegerWeightedMedian([
      { id: 'low', value: 10, effectiveWeight: 0.2 },
      { id: 'middle', value: 20, effectiveWeight: 0.3 },
      { id: 'high', value: 30, effectiveWeight: 0.7 },
    ])

    expect(result?.value).toBe(30)
  })

  it('resists an asymmetric outlier by magnitude and differs from a weighted mean', () => {
    const inputs = [
      { id: 'a', value: 100, effectiveWeight: 1 },
      { id: 'b', value: 101, effectiveWeight: 1 },
      { id: 'outlier', value: 10_000, effectiveWeight: 0.5 },
    ]
    const result = computeSafeIntegerWeightedMedian(inputs)
    const weightedMean = inputs.reduce((sum, input) => sum + input.value * input.effectiveWeight, 0) /
      inputs.reduce((sum, input) => sum + input.effectiveWeight, 0)

    expect(result?.value).toBe(101)
    expect(result?.value).not.toBe(weightedMean)
  })

  it('computes a decimal-safe Stellar amount median', () => {
    const result = computeStellarAmountWeightedMedian([
      { id: 'anchor', value: parseStellarAmount('48198211'), effectiveWeight: 0.5 },
      { id: 'archive', value: parseStellarAmount('48213090.11'), effectiveWeight: 0.9 },
      { id: 'horizon', value: parseStellarAmount('48213092.44'), effectiveWeight: 1 },
    ])

    expect(result?.value.toString()).toBe('48213090.11')
    expect(result?.belowIds).toEqual(['anchor'])
    expect(result?.aboveIds).toEqual(['horizon'])
  })

  it('is deterministic under input reordering and equal values', () => {
    const inputs = [
      { id: 'z', value: 20, effectiveWeight: 1 },
      { id: 'a', value: 20, effectiveWeight: 1 },
      { id: 'low', value: 10, effectiveWeight: 1 },
      { id: 'high', value: 30, effectiveWeight: 1 },
    ]

    const forward = computeSafeIntegerWeightedMedian(inputs)
    const reverse = computeSafeIntegerWeightedMedian([...inputs].reverse())
    expect(reverse).toEqual(forward)
    expect(forward?.selectedId).toBe('a')
    expect(forward?.atIds).toEqual(['a', 'z'])
  })

  it('excludes and reports zero-weight inputs deterministically', () => {
    const result = computeSafeIntegerWeightedMedian([
      { id: 'usable', value: 20, effectiveWeight: 1 },
      { id: 'zero-z', value: 100, effectiveWeight: 0 },
      { id: 'zero-a', value: 1, effectiveWeight: 0 },
    ])

    expect(result?.value).toBe(20)
    expect(result?.excludedZeroWeightIds).toEqual(['zero-a', 'zero-z'])
  })

  it('does not mutate the caller input array', () => {
    const inputs = [
      { id: 'high', value: 20, effectiveWeight: 1 },
      { id: 'low', value: 10, effectiveWeight: 1 },
    ]
    const before = structuredClone(inputs)

    computeSafeIntegerWeightedMedian(inputs)
    expect(inputs).toEqual(before)
  })

  it.each([
    { name: 'negative weight', inputs: [{ id: 'negative', value: 1, effectiveWeight: -1 }] },
    {
      name: 'infinite weight',
      inputs: [{ id: 'infinite', value: 1, effectiveWeight: Number.POSITIVE_INFINITY }],
    },
    {
      name: 'duplicate ID',
      inputs: [
        { id: 'duplicate', value: 1, effectiveWeight: 1 },
        { id: 'duplicate', value: 2, effectiveWeight: 1 },
      ],
    },
    { name: 'empty ID', inputs: [{ id: '', value: 1, effectiveWeight: 1 }] },
  ])('rejects $name', ({ inputs }) => {
    expect(() => computeSafeIntegerWeightedMedian(inputs)).toThrow()
  })

  it('rejects unsafe integer values', () => {
    expect(() =>
      computeSafeIntegerWeightedMedian([
        { id: 'unsafe', value: Number.MAX_SAFE_INTEGER + 1, effectiveWeight: 1 },
      ]),
    ).toThrow(/safe integer/)
  })
})
