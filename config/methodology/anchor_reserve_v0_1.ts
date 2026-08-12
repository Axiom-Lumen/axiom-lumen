export const ANCHOR_RESERVE_METHODOLOGY_VERSION = 'anchor-reserve-comparison-v0.1' as const
export const ANCHOR_RESERVE_ATTESTATION_SCHEMA = 'axiom-lumen-anchor-reserve-attestation-v1' as const

export interface AnchorReserveMethodologyConfig {
  methodologyVersion: typeof ANCHOR_RESERVE_METHODOLOGY_VERSION
  attestationSchema: typeof ANCHOR_RESERVE_ATTESTATION_SCHEMA
  supportedAssetKinds: readonly ['credit']
  unitPolicy: 'exact_asset_units_only'
  maximumAttestationAgeSeconds: number
  maximumReferenceAgeSeconds: number
  maximumPeriodSkewSeconds: number
  verificationValiditySeconds: number
  toleranceBasisPoints: number
  confidence: {
    formulaVersion: 'anchor-reserve-confidence-v0.1'
    selfReportedBase: number
    supplyReferenceCoefficient: number
    temporalAlignmentCoefficient: number
    selfReportedCap: number
    effectiveWeight: number
  }
  publicEndpointPolicy: 'withheld_until_reply_and_review_controls'
}

const candidate: AnchorReserveMethodologyConfig = {
  methodologyVersion: ANCHOR_RESERVE_METHODOLOGY_VERSION,
  attestationSchema: ANCHOR_RESERVE_ATTESTATION_SCHEMA,
  supportedAssetKinds: ['credit'],
  unitPolicy: 'exact_asset_units_only',
  maximumAttestationAgeSeconds: 24 * 60 * 60,
  maximumReferenceAgeSeconds: 120,
  maximumPeriodSkewSeconds: 5 * 60,
  verificationValiditySeconds: 24 * 60 * 60,
  toleranceBasisPoints: 10,
  confidence: {
    formulaVersion: 'anchor-reserve-confidence-v0.1',
    selfReportedBase: 0.25,
    supplyReferenceCoefficient: 0.2,
    temporalAlignmentCoefficient: 0.05,
    selfReportedCap: 0.5,
    effectiveWeight: 0.5,
  },
  publicEndpointPolicy: 'withheld_until_reply_and_review_controls',
}

export function validateAnchorReserveMethodologyConfig(
  config: AnchorReserveMethodologyConfig,
): AnchorReserveMethodologyConfig {
  if (config.methodologyVersion !== ANCHOR_RESERVE_METHODOLOGY_VERSION) {
    throw new Error(`anchor reserve methodology must be ${ANCHOR_RESERVE_METHODOLOGY_VERSION}`)
  }
  if (config.attestationSchema !== ANCHOR_RESERVE_ATTESTATION_SCHEMA) {
    throw new Error(`anchor reserve attestation schema must be ${ANCHOR_RESERVE_ATTESTATION_SCHEMA}`)
  }
  if (config.supportedAssetKinds.length !== 1 || config.supportedAssetKinds[0] !== 'credit') {
    throw new Error('anchor reserve comparison supports classic credit assets only')
  }
  if (config.unitPolicy !== 'exact_asset_units_only') {
    throw new Error('anchor reserve comparison requires exact asset units')
  }
  for (const [name, value] of Object.entries({
    maximumAttestationAgeSeconds: config.maximumAttestationAgeSeconds,
    maximumReferenceAgeSeconds: config.maximumReferenceAgeSeconds,
    maximumPeriodSkewSeconds: config.maximumPeriodSkewSeconds,
    verificationValiditySeconds: config.verificationValiditySeconds,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
  }
  if (!Number.isSafeInteger(config.toleranceBasisPoints) || config.toleranceBasisPoints < 0 || config.toleranceBasisPoints > 10_000) {
    throw new Error('anchor reserve tolerance must be an integer from zero to 10000 basis points')
  }
  if (config.confidence.formulaVersion !== 'anchor-reserve-confidence-v0.1') throw new Error('anchor reserve confidence formula version is invalid')
  for (const [name, value] of Object.entries(config.confidence)) {
    if (name !== 'formulaVersion' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`anchor reserve confidence ${name} must be between zero and one`)
    }
  }
  if (config.confidence.selfReportedBase + config.confidence.supplyReferenceCoefficient + config.confidence.temporalAlignmentCoefficient > config.confidence.selfReportedCap) {
    throw new Error('anchor reserve confidence coefficients must not exceed the self-reported cap')
  }
  if (config.publicEndpointPolicy !== 'withheld_until_reply_and_review_controls') {
    throw new Error('anchor reserve output must remain withheld until reply and review controls exist')
  }
  return config
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) deepFreeze(nested)
  }
  return Object.freeze(value)
}

export const anchorReserveMethodologyConfig = deepFreeze(validateAnchorReserveMethodologyConfig(candidate))
