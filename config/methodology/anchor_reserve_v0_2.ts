export const MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION = 'anchor-reserve-comparison-v0.2' as const
export const MZAR_RESERVE_ATTESTATION_SCHEMA = 'mesh-mzar-reserve-report-v1' as const
export const MZAR_RESERVE_CONNECTOR_PROFILE = 'mesh_mzar_pdf_v1' as const

export interface MzarAnchorReserveMethodologyConfig {
  methodologyVersion: typeof MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION
  attestationSchema: typeof MZAR_RESERVE_ATTESTATION_SCHEMA
  connectorProfile: typeof MZAR_RESERVE_CONNECTOR_PROFILE
  comparisonBoundary: 'historical_ledger_close_at_report_cutoff'
  unitPolicy: 'documented_one_to_one_zar_to_mzar'
  maximumReportCutoffAgeSeconds: number
  maximumPublicationDelaySeconds: number
  maximumReferenceSkewSeconds: number
  verificationValiditySeconds: number
  toleranceBasisPoints: number
  confidence: {
    formulaVersion: 'anchor-reserve-confidence-v0.2'
    selfReportedBase: number
    supplyReferenceCoefficient: number
    temporalAlignmentCoefficient: number
    selfReportedCap: number
    effectiveWeight: number
  }
  publicEndpointPolicy: 'withheld_until_reply_and_review_controls'
}

const candidate: MzarAnchorReserveMethodologyConfig = {
  methodologyVersion: MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION,
  attestationSchema: MZAR_RESERVE_ATTESTATION_SCHEMA,
  connectorProfile: MZAR_RESERVE_CONNECTOR_PROFILE,
  comparisonBoundary: 'historical_ledger_close_at_report_cutoff',
  unitPolicy: 'documented_one_to_one_zar_to_mzar',
  maximumReportCutoffAgeSeconds: 62 * 24 * 60 * 60,
  maximumPublicationDelaySeconds: 35 * 24 * 60 * 60,
  maximumReferenceSkewSeconds: 5 * 60,
  verificationValiditySeconds: 24 * 60 * 60,
  toleranceBasisPoints: 10,
  confidence: {
    formulaVersion: 'anchor-reserve-confidence-v0.2',
    selfReportedBase: 0.25,
    supplyReferenceCoefficient: 0.2,
    temporalAlignmentCoefficient: 0.05,
    selfReportedCap: 0.5,
    effectiveWeight: 0.5,
  },
  publicEndpointPolicy: 'withheld_until_reply_and_review_controls',
}

export function validateMzarAnchorReserveMethodologyConfig(
  config: MzarAnchorReserveMethodologyConfig,
): MzarAnchorReserveMethodologyConfig {
  if (config.methodologyVersion !== MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION) throw new Error('mZAR reserve methodology version is invalid')
  if (config.attestationSchema !== MZAR_RESERVE_ATTESTATION_SCHEMA) throw new Error('mZAR reserve attestation schema is invalid')
  if (config.connectorProfile !== MZAR_RESERVE_CONNECTOR_PROFILE) throw new Error('mZAR reserve connector profile is invalid')
  if (config.comparisonBoundary !== 'historical_ledger_close_at_report_cutoff') throw new Error('mZAR comparisons require a historical ledger-close boundary')
  if (config.unitPolicy !== 'documented_one_to_one_zar_to_mzar') throw new Error('mZAR reserve units require the documented one-to-one ZAR redemption policy')
  for (const [name, value] of Object.entries({
    maximumReportCutoffAgeSeconds: config.maximumReportCutoffAgeSeconds,
    maximumPublicationDelaySeconds: config.maximumPublicationDelaySeconds,
    maximumReferenceSkewSeconds: config.maximumReferenceSkewSeconds,
    verificationValiditySeconds: config.verificationValiditySeconds,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
  }
  if (!Number.isSafeInteger(config.toleranceBasisPoints) || config.toleranceBasisPoints < 0 || config.toleranceBasisPoints > 10_000) throw new Error('mZAR reserve tolerance is invalid')
  if (config.confidence.formulaVersion !== 'anchor-reserve-confidence-v0.2') throw new Error('mZAR reserve confidence formula version is invalid')
  for (const [name, value] of Object.entries(config.confidence)) {
    if (name !== 'formulaVersion' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`mZAR reserve confidence ${name} must be between zero and one`)
  }
  if (config.confidence.selfReportedBase + config.confidence.supplyReferenceCoefficient + config.confidence.temporalAlignmentCoefficient > config.confidence.selfReportedCap) throw new Error('mZAR reserve confidence coefficients exceed their cap')
  if (config.publicEndpointPolicy !== 'withheld_until_reply_and_review_controls') throw new Error('mZAR reserve output must remain withheld')
  return config
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) deepFreeze(nested)
  return Object.freeze(value)
}

export const mzarAnchorReserveMethodologyConfig = deepFreeze(validateMzarAnchorReserveMethodologyConfig(candidate))
