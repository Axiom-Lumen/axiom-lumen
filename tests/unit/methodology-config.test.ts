import { describe, expect, it } from 'vitest'
import {
  METHODOLOGY_VERSION,
  SOURCE_CLASS_IDS,
  methodologyConfig,
  validateMethodologyConfig,
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
})
