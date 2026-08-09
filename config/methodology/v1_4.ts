export const METHODOLOGY_VERSION = 'v1.4' as const

export const SOURCE_CLASS_IDS = [
  'canonical_ledger',
  'archive',
  'dex',
  'anchor_self_reported',
  'third_party_oracle',
] as const

export type SourceClassId = (typeof SOURCE_CLASS_IDS)[number]

interface SourceClassConfig {
  label: string
  example: string
  baseWeight: number
}

interface MethodologyConfig {
  version: typeof METHODOLOGY_VERSION
  sourceClasses: Record<SourceClassId, SourceClassConfig>
  discrepancy: {
    infoMaximumToleranceMultiplier: number
    criticalMinimumConsecutiveCycles: number
  }
  publication: {
    replyWindowHours: number
    namedPartyRequiresHumanApproval: boolean
  }
  metrics: {
    latestLedger: {
      methodologyVersion: 'latest-ledger-v0.1'
      sourceClass: 'canonical_ledger'
      collectionMode: 'request_time'
      refreshCadenceSeconds: null
      freshnessHalfLifeSeconds: number
      agreementToleranceLedgers: number
      minimumVerifiedSources: number
      confidence: {
        formulaVersion: 'latest-ledger-confidence-v0.1'
        agreementCoefficient: number
        freshnessCoefficient: number
        availabilityCoefficient: number
        spreadCoefficient: number
        maximumSpreadLedgers: number
        verifiedThreshold: number
        singleSourceCap: number
        sourceErrorCap: number
      }
    }
  }
}

const candidate = {
  version: METHODOLOGY_VERSION,
  sourceClasses: {
    canonical_ledger: {
      label: 'Canonical ledger state',
      example: 'Stellar Core validator quorum, closed-ledger data',
      baseWeight: 1,
    },
    archive: {
      label: 'Archive',
      example: 'Stellar history archives, full-history nodes',
      baseWeight: 0.9,
    },
    dex: {
      label: 'DEX',
      example: 'Stellar DEX order books and trade streams',
      baseWeight: 0.85,
    },
    anchor_self_reported: {
      label: 'Anchor self-reported',
      example: 'Anchor reserve endpoints, published supply figures',
      baseWeight: 0.5,
    },
    third_party_oracle: {
      label: 'Third-party oracle',
      example: 'External price and reserve attestation feeds',
      baseWeight: 0.4,
    },
  },
  discrepancy: {
    infoMaximumToleranceMultiplier: 2,
    criticalMinimumConsecutiveCycles: 3,
  },
  publication: {
    replyWindowHours: 72,
    namedPartyRequiresHumanApproval: true,
  },
  metrics: {
    latestLedger: {
      methodologyVersion: 'latest-ledger-v0.1',
      sourceClass: 'canonical_ledger',
      collectionMode: 'request_time',
      refreshCadenceSeconds: null,
      freshnessHalfLifeSeconds: 30,
      agreementToleranceLedgers: 1,
      minimumVerifiedSources: 2,
      confidence: {
        formulaVersion: 'latest-ledger-confidence-v0.1',
        agreementCoefficient: 0.5,
        freshnessCoefficient: 0.25,
        availabilityCoefficient: 0.2,
        spreadCoefficient: 0.05,
        maximumSpreadLedgers: 5,
        verifiedThreshold: 0.9,
        singleSourceCap: 0.6,
        sourceErrorCap: 0.85,
      },
    },
  },
} satisfies MethodologyConfig

function assertFiniteInRange(name: string, value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a finite number from ${minimum} to ${maximum}`)
  }
}

export function validateMethodologyConfig(config: MethodologyConfig): MethodologyConfig {
  if (config.version !== METHODOLOGY_VERSION) {
    throw new Error(`methodology version must be ${METHODOLOGY_VERSION}`)
  }

  for (const sourceClassId of SOURCE_CLASS_IDS) {
    const sourceClass = config.sourceClasses[sourceClassId]
    if (!sourceClass || !sourceClass.label.trim() || !sourceClass.example.trim()) {
      throw new Error(`source class ${sourceClassId} must have a label and example`)
    }
    assertFiniteInRange(`sourceClasses.${sourceClassId}.baseWeight`, sourceClass.baseWeight, 0, 1)
    if (sourceClass.baseWeight === 0) {
      throw new Error(`sourceClasses.${sourceClassId}.baseWeight must be greater than zero`)
    }
  }

  assertFiniteInRange(
    'discrepancy.infoMaximumToleranceMultiplier',
    config.discrepancy.infoMaximumToleranceMultiplier,
    1,
    Number.MAX_SAFE_INTEGER,
  )
  if (
    !Number.isSafeInteger(config.discrepancy.criticalMinimumConsecutiveCycles) ||
    config.discrepancy.criticalMinimumConsecutiveCycles < 2
  ) {
    throw new Error('discrepancy.criticalMinimumConsecutiveCycles must be an integer of at least 2')
  }
  if (!Number.isSafeInteger(config.publication.replyWindowHours) || config.publication.replyWindowHours <= 0) {
    throw new Error('publication.replyWindowHours must be a positive integer')
  }
  if (!config.publication.namedPartyRequiresHumanApproval) {
    throw new Error('named-party publication must require human approval')
  }

  const latestLedger = config.metrics.latestLedger
  assertFiniteInRange(
    'metrics.latestLedger.freshnessHalfLifeSeconds',
    latestLedger.freshnessHalfLifeSeconds,
    Number.MIN_VALUE,
    Number.MAX_SAFE_INTEGER,
  )
  if (!Number.isSafeInteger(latestLedger.agreementToleranceLedgers) || latestLedger.agreementToleranceLedgers < 0) {
    throw new Error('metrics.latestLedger.agreementToleranceLedgers must be a non-negative integer')
  }
  if (!Number.isSafeInteger(latestLedger.minimumVerifiedSources) || latestLedger.minimumVerifiedSources < 2) {
    throw new Error('metrics.latestLedger.minimumVerifiedSources must be an integer of at least 2')
  }

  const confidence = latestLedger.confidence
  const coefficients = [
    confidence.agreementCoefficient,
    confidence.freshnessCoefficient,
    confidence.availabilityCoefficient,
    confidence.spreadCoefficient,
  ]
  coefficients.forEach((value, index) => assertFiniteInRange(`confidence coefficient ${index}`, value, 0, 1))
  const coefficientTotal = coefficients.reduce((total, value) => total + value, 0)
  if (Math.abs(coefficientTotal - 1) > Number.EPSILON * 10) {
    throw new Error('latest-ledger confidence coefficients must sum to 1')
  }
  assertFiniteInRange('confidence.verifiedThreshold', confidence.verifiedThreshold, 0, 1)
  assertFiniteInRange('confidence.singleSourceCap', confidence.singleSourceCap, 0, 1)
  assertFiniteInRange('confidence.sourceErrorCap', confidence.sourceErrorCap, 0, 1)
  if (!Number.isSafeInteger(confidence.maximumSpreadLedgers) || confidence.maximumSpreadLedgers <= 0) {
    throw new Error('confidence.maximumSpreadLedgers must be a positive integer')
  }

  return config
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) {
      deepFreeze(nested)
    }
  }
  return Object.freeze(value)
}

export const methodologyConfig = deepFreeze(validateMethodologyConfig(candidate))
