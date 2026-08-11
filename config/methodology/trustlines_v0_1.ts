export const TRUSTLINE_METHODOLOGY_VERSION = 'trustline-state-v0.1' as const
export const TRUSTLINE_STATE_IDS = ['authorized', 'authorized_to_maintain_liabilities', 'unauthorized'] as const
export type TrustlineStateId = (typeof TRUSTLINE_STATE_IDS)[number]

export interface TrustlineMethodologyConfig {
  methodologyVersion: typeof TRUSTLINE_METHODOLOGY_VERSION
  domainMetricId: 'trustline_count'
  publicMetricId: 'trustline_state'
  canonicalPath: '/api/v1/trustlines/{asset}'
  supportedAssetKinds: readonly ['credit']
  states: readonly TrustlineStateId[]
  totalDefinition: 'sum_of_authorization_states'
  fundedHolderPolicy: 'not_measured'
  comparisonTolerance: 0
  minimumIndependentDerivations: 2
  horizonReplicasAreIndependent: false
  freshnessHalfLifeSeconds: number
  maximumObservationAgeSeconds: number
  sourceClassBaseWeights: Readonly<Record<'canonical_ledger' | 'archive' | 'dex' | 'anchor_self_reported' | 'third_party_oracle', number>>
  confidence: {
    formulaVersion: 'trustline-state-confidence-v0.1'
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

const candidate: TrustlineMethodologyConfig = {
  methodologyVersion: TRUSTLINE_METHODOLOGY_VERSION,
  domainMetricId: 'trustline_count',
  publicMetricId: 'trustline_state',
  canonicalPath: '/api/v1/trustlines/{asset}',
  supportedAssetKinds: ['credit'],
  states: TRUSTLINE_STATE_IDS,
  totalDefinition: 'sum_of_authorization_states',
  fundedHolderPolicy: 'not_measured',
  comparisonTolerance: 0,
  minimumIndependentDerivations: 2,
  horizonReplicasAreIndependent: false,
  freshnessHalfLifeSeconds: 300,
  maximumObservationAgeSeconds: 900,
  sourceClassBaseWeights: { canonical_ledger: 1, archive: 0.9, dex: 0.85, anchor_self_reported: 0.5, third_party_oracle: 0.4 },
  confidence: {
    formulaVersion: 'trustline-state-confidence-v0.1', agreementCoefficient: 0.55,
    freshnessCoefficient: 0.2, availabilityCoefficient: 0.2, spreadCoefficient: 0.05,
    verifiedThreshold: 0.9, singleSourceCap: 0.6, sameDerivationCap: 0.7, sourceErrorCap: 0.85,
  },
}

function unit(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be from zero to one`)
}
export function validateTrustlineMethodologyConfig(config: TrustlineMethodologyConfig) {
  if (config.methodologyVersion !== TRUSTLINE_METHODOLOGY_VERSION || config.domainMetricId !== 'trustline_count' || config.publicMetricId !== 'trustline_state') throw new Error('trustline metric identity is incompatible')
  if (config.canonicalPath !== '/api/v1/trustlines/{asset}' || config.supportedAssetKinds.join(',') !== 'credit') throw new Error('trustline route scope is incompatible')
  if (config.states.join(',') !== TRUSTLINE_STATE_IDS.join(',') || config.totalDefinition !== 'sum_of_authorization_states') throw new Error('trustline states are incompatible')
  if (config.fundedHolderPolicy !== 'not_measured') throw new Error('funded holders require a separate methodology')
  if (config.comparisonTolerance !== 0 || config.minimumIndependentDerivations < 2 || config.horizonReplicasAreIndependent) throw new Error('trustline evidence policy is incompatible')
  if (!(config.freshnessHalfLifeSeconds > 0) || !(config.maximumObservationAgeSeconds > config.freshnessHalfLifeSeconds)) throw new Error('trustline freshness bounds are incompatible')
  if (Object.values(config.sourceClassBaseWeights).some((weight) => !(weight > 0 && weight <= 1))) throw new Error('trustline source weights are incompatible')
  const coefficients = [config.confidence.agreementCoefficient, config.confidence.freshnessCoefficient, config.confidence.availabilityCoefficient, config.confidence.spreadCoefficient]
  coefficients.forEach((value, index) => unit(`trustline confidence coefficient ${index}`, value))
  if (Math.abs(coefficients.reduce((sum, value) => sum + value, 0) - 1) > Number.EPSILON * 10) throw new Error('trustline confidence coefficients must sum to one')
  ;[config.confidence.verifiedThreshold, config.confidence.singleSourceCap, config.confidence.sameDerivationCap, config.confidence.sourceErrorCap].forEach((value, index) => unit(`trustline confidence bound ${index}`, value))
  return config
}
function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) deepFreeze(nested)
  return Object.freeze(value)
}
export const trustlineMethodologyConfig = deepFreeze(validateTrustlineMethodologyConfig(candidate))
