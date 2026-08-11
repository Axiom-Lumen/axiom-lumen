export const DEPTH_METHODOLOGY_VERSION = 'order-book-depth-v0.1' as const
export const DEPTH_PRICE_BANDS_BPS = [50, 100, 500] as const

export interface DepthMethodologyConfig {
  methodologyVersion: typeof DEPTH_METHODOLOGY_VERSION
  domainMetricId: 'order_book_depth'
  priceUnit: 'counter_per_base'
  aggregationUnit: 'base_asset_equivalent'
  referencePrice: 'two_sided_midpoint'
  priceBandsBasisPoints: readonly number[]
  amountDecimals: 7
  liquidityPoolPolicy: 'excluded'
  horizonReplicasAreIndependent: false
  freshnessHalfLifeSeconds: number
  maximumObservationAgeSeconds: number
}

const candidate: DepthMethodologyConfig = {
  methodologyVersion: DEPTH_METHODOLOGY_VERSION,
  domainMetricId: 'order_book_depth',
  priceUnit: 'counter_per_base',
  aggregationUnit: 'base_asset_equivalent',
  referencePrice: 'two_sided_midpoint',
  priceBandsBasisPoints: DEPTH_PRICE_BANDS_BPS,
  amountDecimals: 7,
  liquidityPoolPolicy: 'excluded',
  horizonReplicasAreIndependent: false,
  freshnessHalfLifeSeconds: 5,
  maximumObservationAgeSeconds: 20,
}

export function validateDepthMethodologyConfig(config: DepthMethodologyConfig): DepthMethodologyConfig {
  if (config.methodologyVersion !== DEPTH_METHODOLOGY_VERSION) {
    throw new Error(`depth methodology version must be ${DEPTH_METHODOLOGY_VERSION}`)
  }
  if (config.domainMetricId !== 'order_book_depth') throw new Error('depth domain metric ID is incompatible')
  if (config.priceUnit !== 'counter_per_base') throw new Error('depth prices must be counter units per base unit')
  if (config.aggregationUnit !== 'base_asset_equivalent') {
    throw new Error('depth must aggregate in base-asset-equivalent units')
  }
  if (config.referencePrice !== 'two_sided_midpoint') throw new Error('depth requires a two-sided midpoint')
  if (
    config.priceBandsBasisPoints.length === 0 ||
    config.priceBandsBasisPoints.some((band) => !Number.isSafeInteger(band) || band <= 0 || band >= 10_000) ||
    config.priceBandsBasisPoints.some((band, index, bands) => index > 0 && band <= bands[index - 1]!)
  ) {
    throw new Error('depth price bands must be unique ascending integers between 1 and 9,999 basis points')
  }
  if (config.amountDecimals !== 7) throw new Error('depth amounts must use seven decimal places')
  if (config.liquidityPoolPolicy !== 'excluded') throw new Error('depth v0.1 excludes liquidity pools')
  if (config.horizonReplicasAreIndependent) throw new Error('Horizon replicas must not count as independent evidence')
  if (!Number.isFinite(config.freshnessHalfLifeSeconds) || config.freshnessHalfLifeSeconds <= 0) {
    throw new Error('depth freshness half-life must be greater than zero')
  }
  if (
    !Number.isFinite(config.maximumObservationAgeSeconds) ||
    config.maximumObservationAgeSeconds <= config.freshnessHalfLifeSeconds
  ) {
    throw new Error('depth maximum observation age must exceed its freshness half-life')
  }
  return config
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) deepFreeze(nested)
  }
  return Object.freeze(value)
}

export const depthMethodologyConfig = deepFreeze(validateDepthMethodologyConfig(candidate))
