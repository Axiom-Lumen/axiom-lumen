import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  StellarAmount,
  absoluteDelta,
  isWithinBasisPoints,
  parseStellarAmount,
} from '../../lib/stellar/amount'

const stroops = fc.bigInt({
  min: -(10n ** 40n),
  max: 10n ** 40n,
})

describe('decimal-safe amount properties', () => {
  it('round-trips every generated scaled integer through canonical decimal text', () => {
    fc.assert(fc.property(stroops, (value) => {
      const amount = StellarAmount.fromStroops(value)
      expect(parseStellarAmount(amount.toString(), { allowNegative: true }).toStroops()).toBe(value)
      expect(parseStellarAmount(amount.toFixed(), { allowNegative: true }).toStroops()).toBe(value)
    }))
  })

  it('preserves the additive group laws without numeric coercion', () => {
    fc.assert(fc.property(stroops, stroops, stroops, (a, b, c) => {
      const left = StellarAmount.fromStroops(a)
      const middle = StellarAmount.fromStroops(b)
      const right = StellarAmount.fromStroops(c)

      expect(left.add(middle).toStroops()).toBe(a + b)
      expect(left.subtract(middle).toStroops()).toBe(a - b)
      expect(left.add(middle).add(right).toStroops()).toBe(left.add(middle.add(right)).toStroops())
    }))
  })

  it('keeps absolute delta symmetric and basis-point decisions exact', () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 0n, max: 10n ** 30n }),
      fc.bigInt({ min: 0n, max: 10n ** 30n }),
      fc.bigInt({ min: 0n, max: 100_000n }),
      (observedValue, referenceValue, tolerance) => {
        const observed = StellarAmount.fromStroops(observedValue)
        const reference = StellarAmount.fromStroops(referenceValue)
        const expected = referenceValue === 0n
          ? observedValue === 0n
          : (observedValue > referenceValue ? observedValue - referenceValue : referenceValue - observedValue) * 10_000n <=
            referenceValue * tolerance

        expect(absoluteDelta(observed, reference).toStroops()).toBe(absoluteDelta(reference, observed).toStroops())
        expect(isWithinBasisPoints(observed, reference, tolerance)).toBe(expected)
      },
    ))
  })
})
