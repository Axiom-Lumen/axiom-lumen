export const SUPPLY_METHODOLOGY_VERSION = 'onchain-asset-supply-v0.1' as const

export const SUPPLY_COMPONENT_IDS = [
  'authorized_trustlines',
  'maintain_liabilities_trustlines',
  'unauthorized_trustlines',
  'claimable_balances',
  'liquidity_pools',
  'contract_balances',
] as const

export type SupplyComponentId = (typeof SUPPLY_COMPONENT_IDS)[number]
const SUPPLY_SOURCE_CLASS_IDS = [
  'canonical_ledger',
  'archive',
  'dex',
  'anchor_self_reported',
  'third_party_oracle',
] as const
type SupplySourceClassId = (typeof SUPPLY_SOURCE_CLASS_IDS)[number]

export interface SupplyMethodologyConfig {
  methodologyVersion: typeof SUPPLY_METHODOLOGY_VERSION
  domainMetricId: 'circulating_supply'
  publicMetricId: 'onchain_asset_supply'
  publicLabel: 'On-chain asset supply'
  canonicalPath: '/api/v1/supply/{asset}'
  supportedAssetKinds: readonly ['credit']
  amountDecimals: 7
  includedComponents: readonly SupplyComponentId[]
  comparisonToleranceStroops: 0
  minimumIndependentDerivations: 2
  horizonReplicasAreIndependent: false
  nativeAssetPolicy: 'unsupported_requires_native_specific_profile'
  freshnessHalfLifeSeconds: number
  maximumObservationAgeSeconds: number
  sourceClassBaseWeights: Readonly<Record<SupplySourceClassId, number>>
  confidence: {
    formulaVersion: 'onchain-asset-supply-confidence-v0.1'
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

const candidate: SupplyMethodologyConfig = {
  methodologyVersion: SUPPLY_METHODOLOGY_VERSION,
  domainMetricId: 'circulating_supply',
  publicMetricId: 'onchain_asset_supply',
  publicLabel: 'On-chain asset supply',
  canonicalPath: '/api/v1/supply/{asset}',
  supportedAssetKinds: ['credit'],
  amountDecimals: 7,
  includedComponents: SUPPLY_COMPONENT_IDS,
  comparisonToleranceStroops: 0,
  minimumIndependentDerivations: 2,
  horizonReplicasAreIndependent: false,
  nativeAssetPolicy: 'unsupported_requires_native_specific_profile',
  freshnessHalfLifeSeconds: 30,
  maximumObservationAgeSeconds: 120,
  sourceClassBaseWeights: {
    canonical_ledger: 1,
    archive: 0.9,
    dex: 0.85,
    anchor_self_reported: 0.5,
    third_party_oracle: 0.4,
  },
  confidence: {
    formulaVersion: 'onchain-asset-supply-confidence-v0.1',
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

function assertUnitInterval(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be from zero to one`)
}

export function validateSupplyMethodologyConfig(config: SupplyMethodologyConfig): SupplyMethodologyConfig {
  if (config.methodologyVersion !== SUPPLY_METHODOLOGY_VERSION) {
    throw new Error(`supply methodology version must be ${SUPPLY_METHODOLOGY_VERSION}`)
  }
  if (config.domainMetricId !== 'circulating_supply') throw new Error('supply domain metric ID is incompatible')
  if (config.publicMetricId !== 'onchain_asset_supply') throw new Error('supply public metric ID must describe measured scope')
  if (config.publicLabel !== 'On-chain asset supply') throw new Error('supply public label must describe measured scope')
  if (config.canonicalPath !== '/api/v1/supply/{asset}') throw new Error('supply canonical path is incompatible')
  if (config.supportedAssetKinds.length !== 1 || config.supportedAssetKinds[0] !== 'credit') {
    throw new Error('supply v0.1 supports credit assets only')
  }
  if (config.amountDecimals !== 7) throw new Error('supply amounts must use seven decimal places')
  if (
    config.includedComponents.length !== SUPPLY_COMPONENT_IDS.length ||
    SUPPLY_COMPONENT_IDS.some((component) => !config.includedComponents.includes(component)) ||
    new Set(config.includedComponents).size !== SUPPLY_COMPONENT_IDS.length
  ) {
    throw new Error('supply components must include every ledger container exactly once')
  }
  const configuredSourceClasses = Object.keys(config.sourceClassBaseWeights)
  if (
    configuredSourceClasses.length !== SUPPLY_SOURCE_CLASS_IDS.length ||
    SUPPLY_SOURCE_CLASS_IDS.some((sourceClass) => !configuredSourceClasses.includes(sourceClass))
  ) {
    throw new Error('supply methodology must pin every source-class weight exactly once')
  }
  for (const sourceClass of SUPPLY_SOURCE_CLASS_IDS) {
    const weight = config.sourceClassBaseWeights[sourceClass]
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1) {
      throw new Error(`supply source-class weight ${sourceClass} must be greater than zero and at most one`)
    }
  }
  if (config.comparisonToleranceStroops !== 0) throw new Error('same-ledger supply comparison tolerance must be zero')
  if (!Number.isSafeInteger(config.minimumIndependentDerivations) || config.minimumIndependentDerivations < 2) {
    throw new Error('verified supply requires at least two independent derivations')
  }
  if (config.horizonReplicasAreIndependent) throw new Error('Horizon replicas must not count as independent evidence')
  if (config.nativeAssetPolicy !== 'unsupported_requires_native_specific_profile') {
    throw new Error('native XLM requires a separate supply profile')
  }
  if (!Number.isFinite(config.freshnessHalfLifeSeconds) || config.freshnessHalfLifeSeconds <= 0) {
    throw new Error('supply freshness half-life must be greater than zero')
  }
  if (
    !Number.isFinite(config.maximumObservationAgeSeconds) ||
    config.maximumObservationAgeSeconds <= config.freshnessHalfLifeSeconds
  ) {
    throw new Error('supply maximum observation age must exceed its freshness half-life')
  }
  if (config.confidence.formulaVersion !== 'onchain-asset-supply-confidence-v0.1') {
    throw new Error('supply confidence formula version is incompatible')
  }
  const coefficients = [
    config.confidence.agreementCoefficient,
    config.confidence.freshnessCoefficient,
    config.confidence.availabilityCoefficient,
    config.confidence.spreadCoefficient,
  ]
  coefficients.forEach((value, index) => assertUnitInterval(`supply confidence coefficient ${index}`, value))
  if (Math.abs(coefficients.reduce((sum, value) => sum + value, 0) - 1) > Number.EPSILON * 10) {
    throw new Error('supply confidence coefficients must sum to one')
  }
  assertUnitInterval('supply verified threshold', config.confidence.verifiedThreshold)
  assertUnitInterval('supply single-source cap', config.confidence.singleSourceCap)
  assertUnitInterval('supply same-derivation cap', config.confidence.sameDerivationCap)
  assertUnitInterval('supply source-error cap', config.confidence.sourceErrorCap)
  return config
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) deepFreeze(nested)
  }
  return Object.freeze(value)
}

export const supplyMethodologyConfig = deepFreeze(validateSupplyMethodologyConfig(candidate))
