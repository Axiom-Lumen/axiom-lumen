import { DEPTH_PRICE_BANDS_BPS } from './depth_v0_1'

export const DEPTH_RECONCILIATION_METHODOLOGY_VERSION = 'order-book-depth-v0.2' as const

export interface DepthReconciliationMethodologyConfig {
  methodologyVersion: typeof DEPTH_RECONCILIATION_METHODOLOGY_VERSION
  ingestionMethodologyVersion: 'order-book-depth-v0.1'
  domainMetricId: 'order_book_depth'
  canonicalPath: '/api/v1/depth/{pair}'
  pairSeparator: '~'
  priceBandsBasisPoints: readonly number[]
  comparisonToleranceBasisPoints: number
  minimumIndependentDerivations: 2
  horizonReplicasAreIndependent: false
  freshnessHalfLifeSeconds: number
  maximumObservationAgeSeconds: number
  sourceClassBaseWeights: Readonly<Record<'canonical_ledger' | 'archive' | 'dex' | 'anchor_self_reported' | 'third_party_oracle', number>>
  confidence: {
    formulaVersion: 'order-book-depth-confidence-v0.2'
    agreementCoefficient: number
    freshnessCoefficient: number
    availabilityCoefficient: number
    spreadCoefficient: number
    verifiedThreshold: number
    singleSourceCap: number
    sameDerivationCap: number
    sourceErrorCap: number
  }
}

const candidate: DepthReconciliationMethodologyConfig = {
  methodologyVersion: DEPTH_RECONCILIATION_METHODOLOGY_VERSION,
  ingestionMethodologyVersion: 'order-book-depth-v0.1',
  domainMetricId: 'order_book_depth',
  canonicalPath: '/api/v1/depth/{pair}',
  pairSeparator: '~',
  priceBandsBasisPoints: DEPTH_PRICE_BANDS_BPS,
  comparisonToleranceBasisPoints: 50,
  minimumIndependentDerivations: 2,
  horizonReplicasAreIndependent: false,
  freshnessHalfLifeSeconds: 5,
  maximumObservationAgeSeconds: 20,
  sourceClassBaseWeights: {
    canonical_ledger: 1,
    archive: 0.9,
    dex: 0.85,
    anchor_self_reported: 0.5,
    third_party_oracle: 0.4,
  },
  confidence: {
    formulaVersion: 'order-book-depth-confidence-v0.2',
    agreementCoefficient: 0.55,
    freshnessCoefficient: 0.2,
    availabilityCoefficient: 0.2,
    spreadCoefficient: 0.05,
    verifiedThreshold: 0.9,
    singleSourceCap: 0.6,
    sameDerivationCap: 0.7,
    sourceErrorCap: 0.85,
  },
}

function unitInterval(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be from zero to one`)
}

export function validateDepthReconciliationMethodologyConfig(
  config: DepthReconciliationMethodologyConfig,
): DepthReconciliationMethodologyConfig {
  if (config.methodologyVersion !== DEPTH_RECONCILIATION_METHODOLOGY_VERSION) throw new Error('depth reconciliation methodology version is incompatible')
  if (config.ingestionMethodologyVersion !== 'order-book-depth-v0.1') throw new Error('depth ingestion methodology version is incompatible')
  if (config.domainMetricId !== 'order_book_depth') throw new Error('depth domain metric ID is incompatible')
  if (config.canonicalPath !== '/api/v1/depth/{pair}' || config.pairSeparator !== '~') throw new Error('depth route identity is incompatible')
  if (config.priceBandsBasisPoints.join(',') !== DEPTH_PRICE_BANDS_BPS.join(',')) throw new Error('depth reconciliation bands must match ingestion bands')
  if (!Number.isSafeInteger(config.comparisonToleranceBasisPoints) || config.comparisonToleranceBasisPoints < 0 || config.comparisonToleranceBasisPoints >= 10_000) throw new Error('depth comparison tolerance must be valid basis points')
  if (config.minimumIndependentDerivations < 2 || config.horizonReplicasAreIndependent) throw new Error('depth verification requires independent derivations')
  if (!(config.freshnessHalfLifeSeconds > 0) || !(config.maximumObservationAgeSeconds > config.freshnessHalfLifeSeconds)) throw new Error('depth freshness bounds are incompatible')
  if (Object.values(config.sourceClassBaseWeights).some((weight) => !(weight > 0 && weight <= 1))) throw new Error('depth source-class weights are incompatible')
  const coefficients = [config.confidence.agreementCoefficient, config.confidence.freshnessCoefficient, config.confidence.availabilityCoefficient, config.confidence.spreadCoefficient]
  coefficients.forEach((value, index) => unitInterval(`depth confidence coefficient ${index}`, value))
  if (Math.abs(coefficients.reduce((sum, value) => sum + value, 0) - 1) > Number.EPSILON * 10) throw new Error('depth confidence coefficients must sum to one')
  unitInterval('depth verified threshold', config.confidence.verifiedThreshold)
  unitInterval('depth single-source cap', config.confidence.singleSourceCap)
  unitInterval('depth same-derivation cap', config.confidence.sameDerivationCap)
  unitInterval('depth source-error cap', config.confidence.sourceErrorCap)
  return config
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) deepFreeze(nested)
  return Object.freeze(value)
}

export const depthReconciliationMethodologyConfig = deepFreeze(validateDepthReconciliationMethodologyConfig(candidate))
