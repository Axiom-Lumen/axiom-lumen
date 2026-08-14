import { describe, expect, it } from 'vitest'
import { parseStellarAmount } from '../../lib/stellar/amount'
import { StellarPrice, canonicalizeTradingPair } from '../../lib/stellar/price'

const ISSUER = `G${'A'.repeat(55)}`
const USDC = { kind: 'credit' as const, code: 'USDC', issuer: ISSUER }
const XLM = { kind: 'native' as const }

describe('StellarPrice', () => {
  it('compares, inverts, and formats rational prices without floating-point conversion', () => {
    const third = StellarPrice.fromHorizon(1, 3)

    expect(third.format(7)).toBe('0.3333333')
    expect(third.invert().format(7)).toBe('3.0000000')
    expect(third.compare(StellarPrice.fromRatio(2n, 6n))).toBe(0)
    expect(third.midpoint(StellarPrice.fromRatio(1n, 1n)).toJSON()).toEqual({ n: '2', d: '3' })
  })

  it('rounds executable amounts down to the nearest stroop', () => {
    const result = StellarPrice.fromHorizon(1, 3).multiplyAmountFloor(parseStellarAmount('1.0000000'))

    expect(result.toFixed()).toBe('0.3333333')
  })

  it('uses inclusive exact rational price-band boundaries', () => {
    const midpoint = StellarPrice.fromRatio(1n, 1n)

    expect(StellarPrice.fromRatio(99n, 100n).withinBidBand(midpoint, 100)).toBe(true)
    expect(StellarPrice.fromRatio(989_999n, 1_000_000n).withinBidBand(midpoint, 100)).toBe(false)
    expect(StellarPrice.fromRatio(101n, 100n).withinAskBand(midpoint, 100)).toBe(true)
    expect(StellarPrice.fromRatio(1_010_001n, 1_000_000n).withinAskBand(midpoint, 100)).toBe(false)
  })

  it('canonicalizes reversed pairs to one storage key', () => {
    const forward = canonicalizeTradingPair({ base: XLM, counter: USDC })
    const reverse = canonicalizeTradingPair({ base: USDC, counter: XLM })

    expect(forward.pair).toEqual(reverse.pair)
    expect(forward.key).toBe(reverse.key)
    expect(forward.reversed).toBe(false)
    expect(reverse.reversed).toBe(true)
  })

  it('rejects identical assets and invalid Stellar price components', () => {
    expect(() => canonicalizeTradingPair({ base: XLM, counter: XLM })).toThrow(/different/)
    expect(() => StellarPrice.fromHorizon(0, 1)).toThrow(/positive/)
    expect(() => StellarPrice.fromRatio(1n, 0n)).toThrow(/positive/)
  })
})
