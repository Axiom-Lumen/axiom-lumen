import { type AssetId, formatAssetId, tradingPairSchema, type TradingPair } from '../contracts/domain'
import { StellarAmount } from './amount'

const MAX_STELLAR_PRICE_COMPONENT = 2_147_483_647n

function greatestCommonDivisor(left: bigint, right: bigint) {
  let a = left < 0n ? -left : left
  let b = right < 0n ? -right : right
  while (b !== 0n) [a, b] = [b, a % b]
  return a
}

export class StellarPrice {
  readonly numerator: bigint
  readonly denominator: bigint

  private constructor(numerator: bigint, denominator: bigint) {
    const divisor = greatestCommonDivisor(numerator, denominator)
    this.numerator = numerator / divisor
    this.denominator = denominator / divisor
    Object.freeze(this)
  }

  static fromRatio(numerator: bigint, denominator: bigint, enforceStellarBounds = false) {
    if (numerator <= 0n || denominator <= 0n) throw new Error('price ratio components must be positive')
    if (enforceStellarBounds && (numerator > MAX_STELLAR_PRICE_COMPONENT || denominator > MAX_STELLAR_PRICE_COMPONENT)) {
      throw new Error('price ratio components must fit positive signed 32-bit integers')
    }
    return new StellarPrice(numerator, denominator)
  }

  static fromHorizon(numerator: number, denominator: number) {
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
      throw new Error('Horizon price ratio components must be safe integers')
    }
    return StellarPrice.fromRatio(BigInt(numerator), BigInt(denominator), true)
  }

  invert() {
    return StellarPrice.fromRatio(this.denominator, this.numerator)
  }

  compare(other: StellarPrice) {
    const delta = this.numerator * other.denominator - other.numerator * this.denominator
    return delta < 0n ? -1 : delta > 0n ? 1 : 0
  }

  midpoint(other: StellarPrice) {
    return StellarPrice.fromRatio(
      this.numerator * other.denominator + other.numerator * this.denominator,
      2n * this.denominator * other.denominator,
    )
  }

  withinBidBand(midpoint: StellarPrice, basisPoints: number) {
    assertBasisPoints(basisPoints)
    return this.numerator * midpoint.denominator * 10_000n >=
      midpoint.numerator * this.denominator * BigInt(10_000 - basisPoints)
  }

  withinAskBand(midpoint: StellarPrice, basisPoints: number) {
    assertBasisPoints(basisPoints)
    return this.numerator * midpoint.denominator * 10_000n <=
      midpoint.numerator * this.denominator * BigInt(10_000 + basisPoints)
  }

  multiplyAmountFloor(amount: StellarAmount) {
    return StellarAmount.fromStroops(amount.toStroops() * this.numerator / this.denominator)
  }

  format(decimalPlaces = 7) {
    if (!Number.isSafeInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 18) {
      throw new Error('decimalPlaces must be an integer from 0 to 18')
    }
    const scale = 10n ** BigInt(decimalPlaces)
    const scaled = this.numerator * scale
    let rounded = scaled / this.denominator
    if ((scaled % this.denominator) * 2n >= this.denominator) rounded += 1n
    const whole = rounded / scale
    if (decimalPlaces === 0) return whole.toString()
    const fraction = (rounded % scale).toString().padStart(decimalPlaces, '0')
    return `${whole}.${fraction}`
  }

  toJSON() {
    return { n: this.numerator.toString(), d: this.denominator.toString() }
  }
}

function assertBasisPoints(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value >= 10_000) {
    throw new Error('price band must be an integer between 1 and 9,999 basis points')
  }
}

function assetSortKey(asset: AssetId) {
  return asset.kind === 'native' ? '0:native' : `1:${asset.code}:${asset.issuer}`
}

export function canonicalizeTradingPair(input: TradingPair | unknown) {
  const requested = tradingPairSchema.parse(input)
  const reversed = assetSortKey(requested.base) > assetSortKey(requested.counter)
  const pair = reversed ? { base: requested.counter, counter: requested.base } : requested
  return {
    pair: tradingPairSchema.parse(pair),
    key: `${formatAssetId(pair.base)}/${formatAssetId(pair.counter)}`,
    reversed,
  }
}
