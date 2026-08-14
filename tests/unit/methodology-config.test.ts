import { describe, expect, it } from 'vitest'
import {
  DEPTH_METHODOLOGY_VERSION,
  DEPTH_PRICE_BANDS_BPS,
  METHODOLOGY_VERSION,
  SOURCE_CLASS_IDS,
  SUPPLY_COMPONENT_IDS,
  SUPPLY_METHODOLOGY_VERSION,
  depthMethodologyConfig,
  depthReconciliationMethodologyConfig,
  DEPTH_RECONCILIATION_METHODOLOGY_VERSION,
  methodologyConfig,
  supplyMethodologyConfig,
  validateMethodologyConfig,
  validateDepthMethodologyConfig,
  validateSupplyMethodologyConfig,
  TRUSTLINE_METHODOLOGY_VERSION,
  trustlineMethodologyConfig,
  ANCHOR_RESERVE_ATTESTATION_SCHEMA,
  ANCHOR_RESERVE_METHODOLOGY_VERSION,
  anchorReserveMethodologyConfig,
  validateAnchorReserveMethodologyConfig,
  MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION,
  MZAR_RESERVE_ATTESTATION_SCHEMA,
  MZAR_RESERVE_CONNECTOR_PROFILE,
  mzarAnchorReserveMethodologyConfig,
  validateMzarAnchorReserveMethodologyConfig,
} from '../../config/methodology'

describe('methodology v1.5 configuration', () => {
  it('matches the published source-class base weights', () => {
    expect(METHODOLOGY_VERSION).toBe('v1.5')
    expect(SOURCE_CLASS_IDS).toEqual([
      'canonical_ledger',
      'archive',
      'dex',
      'anchor_self_reported',
      'third_party_oracle',
    ])
    expect(
      Object.fromEntries(
        SOURCE_CLASS_IDS.map((sourceClass) => [sourceClass, methodologyConfig.sourceClasses[sourceClass].baseWeight]),
      ),
    ).toEqual({
      canonical_ledger: 1,
      archive: 0.9,
      dex: 0.85,
      anchor_self_reported: 0.5,
      third_party_oracle: 0.4,
    })
  })

  it('captures the approved severity and publication policy', () => {
    expect(methodologyConfig.discrepancy).toEqual({
      infoMaximumToleranceMultiplier: 2,
      criticalMinimumConsecutiveCycles: 3,
    })
    expect(methodologyConfig.publication).toEqual({
      replyWindowHours: 72,
      namedPartyRequiresHumanApproval: true,
    })
  })

  it('captures the implemented latest-ledger v0.2 profile', () => {
    expect(methodologyConfig.metrics.latestLedger).toMatchObject({
      methodologyVersion: 'latest-ledger-v0.2',
      sourceClass: 'canonical_ledger',
      collectionMode: 'request_time',
      refreshCadenceSeconds: null,
      freshnessHalfLifeSeconds: 30,
      agreementToleranceLedgers: 1,
      minimumVerifiedSources: 2,
    })
    expect(methodologyConfig.metrics.latestLedger.confidence).toMatchObject({
      formulaVersion: 'latest-ledger-confidence-v0.2',
      agreementCoefficient: 0.5,
      freshnessCoefficient: 0.25,
      availabilityCoefficient: 0.2,
      spreadCoefficient: 0.05,
      maximumSpreadLedgers: 5,
      verifiedThreshold: 0.9,
      singleSourceCap: 0.6,
      sameUpstreamCap: 0.7,
      sourceErrorCap: 0.85,
    })
  })

  it('rejects a configuration whose confidence coefficients do not sum to one', () => {
    const invalid = structuredClone(methodologyConfig)
    invalid.metrics.latestLedger.confidence.agreementCoefficient = 0.4

    expect(() => validateMethodologyConfig(invalid)).toThrow(/coefficients must sum to 1/)
  })

  it('rejects an invalid same-upstream confidence cap', () => {
    const invalid = structuredClone(methodologyConfig)
    invalid.metrics.latestLedger.confidence.sameUpstreamCap = 1.1

    expect(() => validateMethodologyConfig(invalid)).toThrow(/sameUpstreamCap/)
  })

  it('rejects disabling human approval for named-party publication', () => {
    const invalid = structuredClone(methodologyConfig)
    invalid.publication.namedPartyRequiresHumanApproval = false

    expect(() => validateMethodologyConfig(invalid)).toThrow(/must require human approval/)
  })

  it('freezes executable configuration after validation', () => {
    expect(Object.isFrozen(methodologyConfig)).toBe(true)
    expect(Object.isFrozen(methodologyConfig.sourceClasses)).toBe(true)
    expect(Object.isFrozen(methodologyConfig.metrics.latestLedger.confidence)).toBe(true)
  })

  it('defines the complete on-chain asset-supply v0.1 scope', () => {
    expect(SUPPLY_METHODOLOGY_VERSION).toBe('onchain-asset-supply-v0.1')
    expect(supplyMethodologyConfig).toMatchObject({
      domainMetricId: 'circulating_supply',
      publicMetricId: 'onchain_asset_supply',
      publicLabel: 'On-chain asset supply',
      canonicalPath: '/api/v1/supply/{asset}',
      supportedAssetKinds: ['credit'],
      amountDecimals: 7,
      comparisonToleranceStroops: 0,
      minimumIndependentDerivations: 2,
      horizonReplicasAreIndependent: false,
      nativeAssetPolicy: 'unsupported_requires_native_specific_profile',
      freshnessHalfLifeSeconds: 30,
      maximumObservationAgeSeconds: 120,
    })
    expect(supplyMethodologyConfig.includedComponents).toEqual(SUPPLY_COMPONENT_IDS)
    expect(supplyMethodologyConfig.sourceClassBaseWeights).toEqual({
      canonical_ledger: 1,
      archive: 0.9,
      dex: 0.85,
      anchor_self_reported: 0.5,
      third_party_oracle: 0.4,
    })
    expect(supplyMethodologyConfig.confidence).toMatchObject({
      formulaVersion: 'onchain-asset-supply-confidence-v0.1',
      verifiedThreshold: 0.9,
      sameDerivationCap: 0.7,
    })
    expect(Object.isFrozen(supplyMethodologyConfig)).toBe(true)
    expect(Object.isFrozen(supplyMethodologyConfig.includedComponents)).toBe(true)
  })

  it('rejects partial supply formulas and replica inflation', () => {
    const partial = structuredClone(supplyMethodologyConfig)
    partial.includedComponents = partial.includedComponents.slice(0, -1)
    expect(() => validateSupplyMethodologyConfig(partial)).toThrow(/every ledger container exactly once/)

    const replicaInflation = {
      ...structuredClone(supplyMethodologyConfig),
      horizonReplicasAreIndependent: true,
    } as unknown as Parameters<typeof validateSupplyMethodologyConfig>[0]
    expect(() => validateSupplyMethodologyConfig(replicaInflation)).toThrow(/replicas/)
  })

  it('defines the classic SDEX depth ingestion profile without overstating independence', () => {
    expect(DEPTH_METHODOLOGY_VERSION).toBe('order-book-depth-v0.1')
    expect(DEPTH_PRICE_BANDS_BPS).toEqual([50, 100, 500])
    expect(depthMethodologyConfig).toMatchObject({
      priceUnit: 'counter_per_base',
      aggregationUnit: 'base_asset_equivalent',
      referencePrice: 'two_sided_midpoint',
      liquidityPoolPolicy: 'excluded',
      horizonReplicasAreIndependent: false,
      freshnessHalfLifeSeconds: 5,
      maximumObservationAgeSeconds: 20,
    })
    expect(Object.isFrozen(depthMethodologyConfig)).toBe(true)
    expect(Object.isFrozen(depthMethodologyConfig.priceBandsBasisPoints)).toBe(true)
  })

  it('pins the persisted depth reconciliation and read freshness profile', () => {
    expect(DEPTH_RECONCILIATION_METHODOLOGY_VERSION).toBe('order-book-depth-v0.2')
    expect(depthReconciliationMethodologyConfig).toMatchObject({
      canonicalPath: '/api/v1/depth/{pair}', comparisonToleranceBasisPoints: 50,
      minimumIndependentDerivations: 2, horizonReplicasAreIndependent: false,
      freshnessHalfLifeSeconds: 5, maximumObservationAgeSeconds: 20,
    })
    expect(Object.isFrozen(depthReconciliationMethodologyConfig)).toBe(true)
  })

  it('rejects unordered depth bands and replica inflation', () => {
    const unordered = structuredClone(depthMethodologyConfig)
    unordered.priceBandsBasisPoints = [100, 50]
    expect(() => validateDepthMethodologyConfig(unordered)).toThrow(/ascending/)

    const replicas = {
      ...structuredClone(depthMethodologyConfig),
      horizonReplicasAreIndependent: true,
    } as unknown as Parameters<typeof validateDepthMethodologyConfig>[0]
    expect(() => validateDepthMethodologyConfig(replicas)).toThrow(/replicas/)
  })

  it('defines authorization-state trustlines without calling them funded holders', () => {
    expect(TRUSTLINE_METHODOLOGY_VERSION).toBe('trustline-state-v0.1')
    expect(trustlineMethodologyConfig).toMatchObject({
      publicMetricId: 'trustline_state',
      states: ['authorized', 'authorized_to_maintain_liabilities', 'unauthorized'],
      totalDefinition: 'sum_of_authorization_states',
      fundedHolderPolicy: 'not_measured',
      horizonReplicasAreIndependent: false,
      freshnessHalfLifeSeconds: 300,
      maximumObservationAgeSeconds: 900,
    })
  })

  it('defines a fail-closed, publication-gated anchor reserve comparison', () => {
    expect(ANCHOR_RESERVE_METHODOLOGY_VERSION).toBe('anchor-reserve-comparison-v0.1')
    expect(ANCHOR_RESERVE_ATTESTATION_SCHEMA).toBe('axiom-lumen-anchor-reserve-attestation-v1')
    expect(anchorReserveMethodologyConfig).toMatchObject({
      unitPolicy: 'exact_asset_units_only',
      maximumAttestationAgeSeconds: 86_400,
      maximumReferenceAgeSeconds: 120,
      maximumPeriodSkewSeconds: 300,
      verificationValiditySeconds: 86_400,
      toleranceBasisPoints: 10,
      confidence: {
        formulaVersion: 'anchor-reserve-confidence-v0.1', selfReportedBase: 0.25,
        supplyReferenceCoefficient: 0.2, temporalAlignmentCoefficient: 0.05,
        selfReportedCap: 0.5, effectiveWeight: 0.5,
      },
      publicEndpointPolicy: 'withheld_until_reply_and_review_controls',
    })
    const unsafe = structuredClone(anchorReserveMethodologyConfig)
    unsafe.publicEndpointPolicy = 'public' as never
    expect(() => validateAnchorReserveMethodologyConfig(unsafe)).toThrow(/withheld/)
  })

  it('adds a non-competing historical mZAR profile without changing v0.1', () => {
    expect(MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION).toBe('anchor-reserve-comparison-v0.2')
    expect(MZAR_RESERVE_ATTESTATION_SCHEMA).toBe('mesh-mzar-reserve-report-v1')
    expect(MZAR_RESERVE_CONNECTOR_PROFILE).toBe('mesh_mzar_pdf_v1')
    expect(mzarAnchorReserveMethodologyConfig).toMatchObject({
      comparisonBoundary: 'historical_ledger_close_at_report_cutoff',
      unitPolicy: 'documented_one_to_one_zar_to_mzar',
      maximumReportCutoffAgeSeconds: 5_356_800,
      maximumPublicationDelaySeconds: 3_024_000,
      maximumReferenceSkewSeconds: 300,
      toleranceBasisPoints: 10,
      confidence: { formulaVersion: 'anchor-reserve-confidence-v0.2', selfReportedCap: 0.5 },
      publicEndpointPolicy: 'withheld_until_reply_and_review_controls',
    })
    const unsafe = structuredClone(mzarAnchorReserveMethodologyConfig)
    unsafe.comparisonBoundary = 'historical_ledger_close_at_report_cutoff' as never
    unsafe.maximumPublicationDelaySeconds = 0
    expect(() => validateMzarAnchorReserveMethodologyConfig(unsafe)).toThrow(/maximumPublicationDelaySeconds/)
  })
})
