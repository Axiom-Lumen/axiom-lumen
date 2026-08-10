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
  if (config.comparisonToleranceStroops !== 0) throw new Error('same-ledger supply comparison tolerance must be zero')
  if (!Number.isSafeInteger(config.minimumIndependentDerivations) || config.minimumIndependentDerivations < 2) {
    throw new Error('verified supply requires at least two independent derivations')
  }
  if (config.horizonReplicasAreIndependent) throw new Error('Horizon replicas must not count as independent evidence')
  if (config.nativeAssetPolicy !== 'unsupported_requires_native_specific_profile') {
    throw new Error('native XLM requires a separate supply profile')
  }
  return config
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) deepFreeze(nested)
  }
  return Object.freeze(value)
}

export const supplyMethodologyConfig = deepFreeze(validateSupplyMethodologyConfig(candidate))
