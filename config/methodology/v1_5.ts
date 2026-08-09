import {
  SOURCE_CLASS_IDS,
  methodologyConfig as methodologyV14,
  validateMethodologyConfig as validateMethodologyV14,
  type SourceClassId,
} from './v1_4'

export const METHODOLOGY_VERSION = 'v1.5' as const
export { SOURCE_CLASS_IDS, type SourceClassId }

type MethodologyV14 = Parameters<typeof validateMethodologyV14>[0]
type LatestLedgerV14 = MethodologyV14['metrics']['latestLedger']
type ConfidenceV14 = LatestLedgerV14['confidence']

export interface MethodologyConfig extends Omit<MethodologyV14, 'version' | 'metrics'> {
  version: typeof METHODOLOGY_VERSION
  metrics: {
    latestLedger: Omit<LatestLedgerV14, 'methodologyVersion' | 'confidence'> & {
      methodologyVersion: 'latest-ledger-v0.2'
      confidence: Omit<ConfidenceV14, 'formulaVersion'> & {
        formulaVersion: 'latest-ledger-confidence-v0.2'
        sameUpstreamCap: number
      }
    }
  }
}

const candidate: MethodologyConfig = {
  ...methodologyV14,
  version: METHODOLOGY_VERSION,
  metrics: {
    latestLedger: {
      ...methodologyV14.metrics.latestLedger,
      methodologyVersion: 'latest-ledger-v0.2',
      confidence: {
        ...methodologyV14.metrics.latestLedger.confidence,
        formulaVersion: 'latest-ledger-confidence-v0.2',
        sameUpstreamCap: 0.7,
      },
    },
  },
}

function assertFiniteInRange(name: string, value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a finite number from ${minimum} to ${maximum}`)
  }
}

export function validateMethodologyConfig(config: MethodologyConfig): MethodologyConfig {
  if (config.version !== METHODOLOGY_VERSION) {
    throw new Error(`methodology version must be ${METHODOLOGY_VERSION}`)
  }
  if (config.metrics.latestLedger.methodologyVersion !== 'latest-ledger-v0.2') {
    throw new Error('latest-ledger methodology version must be latest-ledger-v0.2')
  }
  if (config.metrics.latestLedger.confidence.formulaVersion !== 'latest-ledger-confidence-v0.2') {
    throw new Error('latest-ledger confidence formula version must be latest-ledger-confidence-v0.2')
  }

  const { sameUpstreamCap, ...baselineConfidence } = config.metrics.latestLedger.confidence
  validateMethodologyV14({
    ...config,
    version: 'v1.4',
    metrics: {
      latestLedger: {
        ...config.metrics.latestLedger,
        methodologyVersion: 'latest-ledger-v0.1',
        confidence: {
          ...baselineConfidence,
          formulaVersion: 'latest-ledger-confidence-v0.1',
        },
      },
    },
  })
  assertFiniteInRange('confidence.sameUpstreamCap', sameUpstreamCap, 0, 1)

  return config
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) deepFreeze(nested)
  }
  return Object.freeze(value)
}

export const methodologyConfig = deepFreeze(validateMethodologyConfig(candidate))
