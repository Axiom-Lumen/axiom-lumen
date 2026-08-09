import { describe, expect, it } from 'vitest'
import {
  STROOPS_PER_UNIT,
  StellarAmount,
  absoluteDelta,
  isWithinBasisPoints,
  parseStellarAmount,
  percentageDelta,
  relativeDelta,
} from '../../lib/stellar/amount'

describe('StellarAmount', () => {
  it('parses and formats all seven decimal places without floating-point conversion', () => {
    const amount = parseStellarAmount('48213092.4400001')

    expect(amount.toStroops()).toBe(482130924400001n)
    expect(amount.toString()).toBe('48213092.4400001')
    expect(amount.toFixed()).toBe('48213092.4400001')
  })

  it('formats whole values canonically and with fixed Stellar precision', () => {
    const amount = parseStellarAmount('12.0000000')

    expect(amount.toString()).toBe('12')
    expect(amount.toFixed()).toBe('12.0000000')
    expect(JSON.stringify({ amount })).toBe('{"amount":"12"}')
  })

  it('preserves values beyond the JavaScript safe integer range', () => {
    const amount = parseStellarAmount('900719925474099312345.1234567')

    expect(amount.toString()).toBe('900719925474099312345.1234567')
    expect(amount.toStroops()).toBe(9007199254740993123451234567n)
  })

  it('uses one stroop as the minimum positive amount', () => {
    expect(parseStellarAmount('0.0000001').toStroops()).toBe(1n)
    expect(StellarAmount.fromStroops(STROOPS_PER_UNIT).toString()).toBe('1')
  })

  it.each(['1.00000001', '1e3', 'NaN', 'Infinity', '1,000', ' 1', '+1', '01', '1.'])('rejects non-canonical input %s', (value) => {
    expect(() => parseStellarAmount(value)).toThrow(/canonical decimal string/)
  })

  it('rejects negative amounts unless the caller explicitly allows them', () => {
    expect(() => parseStellarAmount('-1.25')).toThrow(/must not be negative/)
    expect(parseStellarAmount('-1.25', { allowNegative: true }).toString()).toBe('-1.25')
    expect(parseStellarAmount('-0', { allowNegative: true }).toString()).toBe('0')
  })

  it('adds, subtracts, compares, and computes absolute delta exactly', () => {
    const left = parseStellarAmount('10.0000001')
    const right = parseStellarAmount('3.0000002')

    expect(left.add(right).toString()).toBe('13.0000003')
    expect(left.subtract(right).toString()).toBe('6.9999999')
    expect(right.subtract(left).toString()).toBe('-6.9999999')
    expect(absoluteDelta(right, left).toString()).toBe('6.9999999')
    expect(left.compare(right)).toBe(1)
    expect(left.equals(parseStellarAmount('10.0000001'))).toBe(true)
  })

  it('prevents implicit conversion to JavaScript number', () => {
    const amount = parseStellarAmount('1')

    expect(() => Number(amount)).toThrow(/cannot be converted to number/)
  })

  it('returns exact relative-delta fraction parts', () => {
    const delta = relativeDelta(parseStellarAmount('105'), parseStellarAmount('100'))

    expect(delta).toEqual({
      numerator: 5n * STROOPS_PER_UNIT,
      denominator: 100n * STROOPS_PER_UNIT,
    })
  })

  it('formats percentage delta with deterministic half-up rounding', () => {
    expect(percentageDelta(parseStellarAmount('100.01'), parseStellarAmount('100'), 4)).toBe('0.0100')
    expect(percentageDelta(parseStellarAmount('2'), parseStellarAmount('3'), 2)).toBe('33.33')
    expect(percentageDelta(parseStellarAmount('2'), parseStellarAmount('8'), 0)).toBe('75')
  })

  it('returns null for relative and percentage delta against zero', () => {
    const observed = parseStellarAmount('1')
    const zero = parseStellarAmount('0')

    expect(relativeDelta(observed, zero)).toBeNull()
    expect(percentageDelta(observed, zero)).toBeNull()
  })

  it('compares basis-point tolerance inclusively without division', () => {
    const reference = parseStellarAmount('100')

    expect(isWithinBasisPoints(parseStellarAmount('100.1'), reference, 10n)).toBe(true)
    expect(isWithinBasisPoints(parseStellarAmount('99.9'), reference, 10n)).toBe(true)
    expect(isWithinBasisPoints(parseStellarAmount('100.1000001'), reference, 10n)).toBe(false)
  })

  it('only treats zero as within a relative tolerance when the reference is zero', () => {
    const zero = parseStellarAmount('0')

    expect(isWithinBasisPoints(zero, zero, 0n)).toBe(true)
    expect(isWithinBasisPoints(parseStellarAmount('0.0000001'), zero, 10_000n)).toBe(false)
  })
})

