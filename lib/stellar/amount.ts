export const STELLAR_AMOUNT_DECIMALS = 7
export const STROOPS_PER_UNIT = 10n ** BigInt(STELLAR_AMOUNT_DECIMALS)

export interface ParseStellarAmountOptions {
  allowNegative?: boolean
}

const AMOUNT_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,7}))?$/

function formatScaledInteger(value: bigint, decimalPlaces: number, trimTrailingZeros: boolean) {
  const negative = value < 0n
  const absolute = negative ? -value : value
  const scale = 10n ** BigInt(decimalPlaces)
  const whole = absolute / scale
  const fractionValue = absolute % scale

  if (decimalPlaces === 0) return `${negative ? '-' : ''}${whole}`

  let fraction = fractionValue.toString().padStart(decimalPlaces, '0')
  if (trimTrailingZeros) fraction = fraction.replace(/0+$/, '')
  const sign = negative && absolute !== 0n ? '-' : ''
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`
}

/**
 * Lossless Stellar amount represented as stroops (10^-7 units).
 *
 * Instances accept no implicit numeric coercion. Serialize amounts as decimal strings with
 * `toString()`, `toFixed()`, or `toJSON()` rather than converting through JavaScript `number`.
 */
export class StellarAmount {
  readonly #stroops: bigint

  private constructor(stroops: bigint) {
    this.#stroops = stroops
    Object.freeze(this)
  }

  static fromStroops(stroops: bigint) {
    return new StellarAmount(stroops)
  }

  static parse(value: string, options: ParseStellarAmountOptions = {}) {
    if (typeof value !== 'string') {
      throw new TypeError('Stellar amount must be provided as a decimal string')
    }

    const match = AMOUNT_PATTERN.exec(value)
    if (!match) {
      throw new Error('Stellar amount must be a canonical decimal string with at most 7 decimal places')
    }

    const [, sign, whole, fraction = ''] = match
    if (sign === '-' && !options.allowNegative) {
      throw new Error('Stellar amount must not be negative')
    }

    const paddedFraction = fraction.padEnd(STELLAR_AMOUNT_DECIMALS, '0')
    const absoluteStroops = BigInt(whole) * STROOPS_PER_UNIT + BigInt(paddedFraction || '0')
    const stroops = sign === '-' && absoluteStroops !== 0n ? -absoluteStroops : absoluteStroops
    return new StellarAmount(stroops)
  }

  toStroops() {
    return this.#stroops
  }

  add(other: StellarAmount) {
    return new StellarAmount(this.#stroops + other.#stroops)
  }

  subtract(other: StellarAmount) {
    return new StellarAmount(this.#stroops - other.#stroops)
  }

  abs() {
    return this.#stroops < 0n ? new StellarAmount(-this.#stroops) : this
  }

  compare(other: StellarAmount) {
    if (this.#stroops < other.#stroops) return -1
    if (this.#stroops > other.#stroops) return 1
    return 0
  }

  equals(other: StellarAmount) {
    return this.#stroops === other.#stroops
  }

  isNegative() {
    return this.#stroops < 0n
  }

  isZero() {
    return this.#stroops === 0n
  }

  toString() {
    return formatScaledInteger(this.#stroops, STELLAR_AMOUNT_DECIMALS, true)
  }

  toFixed() {
    return formatScaledInteger(this.#stroops, STELLAR_AMOUNT_DECIMALS, false)
  }

  toJSON() {
    return this.toString()
  }

  valueOf(): never {
    throw new TypeError('StellarAmount cannot be converted to number; use decimal-safe operations')
  }
}

export function parseStellarAmount(value: string, options?: ParseStellarAmountOptions) {
  return StellarAmount.parse(value, options)
}

export function absoluteDelta(left: StellarAmount, right: StellarAmount) {
  return left.subtract(right).abs()
}

/** Returns the exact absolute relative delta as a fraction, or null when the reference is zero. */
export function relativeDelta(
  observed: StellarAmount,
  reference: StellarAmount,
): { numerator: bigint; denominator: bigint } | null {
  const denominator = reference.abs().toStroops()
  if (denominator === 0n) return null
  return {
    numerator: absoluteDelta(observed, reference).toStroops(),
    denominator,
  }
}

/**
 * Formats absolute percentage delta with deterministic half-up rounding.
 * Returns null when percentage delta is undefined because the reference is zero.
 */
export function percentageDelta(
  observed: StellarAmount,
  reference: StellarAmount,
  decimalPlaces = STELLAR_AMOUNT_DECIMALS,
): string | null {
  if (!Number.isSafeInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 18) {
    throw new Error('decimalPlaces must be an integer from 0 to 18')
  }

  const delta = relativeDelta(observed, reference)
  if (!delta) return null

  const scale = 10n ** BigInt(decimalPlaces)
  const scaledNumerator = delta.numerator * 100n * scale
  let rounded = scaledNumerator / delta.denominator
  const remainder = scaledNumerator % delta.denominator
  if (remainder * 2n >= delta.denominator) rounded += 1n
  return formatScaledInteger(rounded, decimalPlaces, false)
}

/** Compares relative deviation without floating-point division. The boundary is inclusive. */
export function isWithinBasisPoints(
  observed: StellarAmount,
  reference: StellarAmount,
  toleranceBasisPoints: bigint,
) {
  if (toleranceBasisPoints < 0n) {
    throw new Error('toleranceBasisPoints must not be negative')
  }

  const delta = relativeDelta(observed, reference)
  if (!delta) return observed.isZero()
  return delta.numerator * 10_000n <= delta.denominator * toleranceBasisPoints
}

