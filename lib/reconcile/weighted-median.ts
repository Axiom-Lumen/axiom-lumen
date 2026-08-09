import { StellarAmount } from '../stellar/amount'

export interface WeightedMedianInput<T> {
  id: string
  value: T
  effectiveWeight: number
}

export interface WeightedMedianResult<T> {
  value: T
  selectedId: string
  totalWeight: number
  belowIds: string[]
  atIds: string[]
  aboveIds: string[]
  excludedZeroWeightIds: string[]
}

export type ValueComparator<T> = (left: T, right: T) => number

function compareIds(left: string, right: string) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Computes a deterministic lower weighted median without performing arithmetic on values.
 *
 * Inputs with zero weight are excluded. Negative or non-finite weights and duplicate/empty IDs are
 * rejected. Inputs are sorted by value and then ID, so input order never affects the result. When
 * cumulative weight lands exactly on half of total weight, the lower value is selected deliberately.
 */
export function computeWeightedMedian<T>(
  inputs: readonly WeightedMedianInput<T>[],
  compareValues: ValueComparator<T>,
): WeightedMedianResult<T> | null {
  const seenIds = new Set<string>()
  const excludedZeroWeightIds: string[] = []
  const contributing: WeightedMedianInput<T>[] = []

  for (const input of inputs) {
    if (!input.id) throw new Error('weighted-median input ID must not be empty')
    if (seenIds.has(input.id)) throw new Error(`duplicate weighted-median input ID: ${input.id}`)
    seenIds.add(input.id)

    if (!Number.isFinite(input.effectiveWeight) || input.effectiveWeight < 0) {
      throw new Error(`effective weight for ${input.id} must be finite and non-negative`)
    }
    if (input.effectiveWeight === 0) {
      excludedZeroWeightIds.push(input.id)
    } else {
      contributing.push(input)
    }
  }

  if (contributing.length === 0) return null

  const sorted = [...contributing].sort((left, right) => {
    const comparison = compareValues(left.value, right.value)
    if (!Number.isFinite(comparison)) throw new Error('value comparator must return a finite number')
    return comparison === 0 ? compareIds(left.id, right.id) : comparison < 0 ? -1 : 1
  })
  const totalWeight = sorted.reduce((total, input) => total + input.effectiveWeight, 0)
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw new Error('total effective weight must be finite and greater than zero')
  }

  const midpoint = totalWeight / 2
  let cumulativeWeight = 0
  let selected = sorted[sorted.length - 1]
  for (const input of sorted) {
    cumulativeWeight += input.effectiveWeight
    if (cumulativeWeight >= midpoint) {
      selected = input
      break
    }
  }

  const belowIds: string[] = []
  const atIds: string[] = []
  const aboveIds: string[] = []
  for (const input of sorted) {
    const comparison = compareValues(input.value, selected.value)
    if (!Number.isFinite(comparison)) throw new Error('value comparator must return a finite number')
    if (comparison < 0) belowIds.push(input.id)
    else if (comparison > 0) aboveIds.push(input.id)
    else atIds.push(input.id)
  }

  return {
    value: selected.value,
    selectedId: selected.id,
    totalWeight,
    belowIds,
    atIds,
    aboveIds,
    excludedZeroWeightIds: excludedZeroWeightIds.sort(compareIds),
  }
}

export function computeSafeIntegerWeightedMedian(inputs: readonly WeightedMedianInput<number>[]) {
  for (const input of inputs) {
    if (!Number.isSafeInteger(input.value)) {
      throw new Error(`value for ${input.id} must be a safe integer`)
    }
  }
  return computeWeightedMedian(inputs, (left, right) => left - right)
}

export function computeStellarAmountWeightedMedian(inputs: readonly WeightedMedianInput<StellarAmount>[]) {
  return computeWeightedMedian(inputs, (left, right) => left.compare(right))
}
