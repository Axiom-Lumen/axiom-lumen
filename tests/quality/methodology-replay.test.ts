import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { methodologyConfig as methodologyV14 } from '../../config/methodology/v1_4'
import { methodologyConfig as methodologyV15 } from '../../config/methodology/v1_5'
import { latestLedgerObservationSchema, type SourceIdentity } from '../../lib/contracts'
import { classifySafeIntegerDeviationBand } from '../../lib/reconcile/discrepancy-state'
import {
  reconcileMetric,
  type MetricReconciliationProfile,
  type ReconciliationMethodologyConfig,
} from '../../lib/reconcile/orchestrator'

const now = new Date('2026-08-13T10:00:00.000Z')
const network = { id: 'public' as const, passphrase: 'Public Global Stellar Network ; September 2015' }
const sources: SourceIdentity[] = ['replica-a', 'replica-b'].map((id) => ({
  id,
  sourceClass: 'canonical_ledger',
  adapter: 'horizon',
  url: `https://${id}.example/`,
  network,
}))
const observations = sources.map((source, index) => ({
  observationId: `observation-${index}`,
  cycleId: 'historical-cycle',
  metric: 'latest_ledger' as const,
  ledgerSequence: 100,
  upstreamId: 'shared-validator-set',
  provenance: { source, sourceTimestamp: now.toISOString(), retrievedAt: now.toISOString() },
}))
const observationSchema = latestLedgerObservationSchema.extend({ upstreamId: latestLedgerObservationSchema.shape.observationId })
type Observation = ReturnType<typeof observationSchema.parse>
const profile: MetricReconciliationProfile<Observation, number> = {
  metric: 'latest_ledger',
  parseObservation: (input) => observationSchema.parse(input),
  matchesSubject: (observation, subject) => subject.kind === 'network' &&
    observation.provenance.source.network.passphrase === subject.network.passphrase,
  getValue: (observation) => observation.ledgerSequence,
  compareValues: (left, right) => left - right,
  agrees: (left, right) => Math.abs(left - right) <= 1,
  deviationBand: (left, right) => classifySafeIntegerDeviationBand({ absoluteDeviation: Math.abs(left - right), tolerance: 1 }),
  spreadDistance: (left, right) => Math.abs(left - right),
  maximumSpreadDistance: 5,
  toMetricValue: (value) => ({ kind: 'ledger', value }),
  getUpstreamId: (observation) => observation.upstreamId,
}

function executableMethodology(version: typeof methodologyV14 | typeof methodologyV15): ReconciliationMethodologyConfig {
  const latest = version.metrics.latestLedger
  return {
    version: latest.methodologyVersion,
    freshnessHalfLifeSeconds: latest.freshnessHalfLifeSeconds,
    expectedSourceClasses: ['canonical_ledger'],
    sourceClassBaseWeights: Object.fromEntries(Object.entries(version.sourceClasses).map(([id, value]) => [id, value.baseWeight])) as ReconciliationMethodologyConfig['sourceClassBaseWeights'],
    minimumVerifiedSources: latest.minimumVerifiedSources,
    verifiedThreshold: latest.confidence.verifiedThreshold,
    confidenceFormulaVersion: latest.confidence.formulaVersion,
    confidenceCoefficients: {
      agreement: latest.confidence.agreementCoefficient,
      freshness: latest.confidence.freshnessCoefficient,
      availability: latest.confidence.availabilityCoefficient,
      spread: latest.confidence.spreadCoefficient,
    },
    singleSourceCap: latest.confidence.singleSourceCap,
    sameUpstreamCap: 'sameUpstreamCap' in latest.confidence ? latest.confidence.sameUpstreamCap : 1,
    sourceErrorCap: latest.confidence.sourceErrorCap,
  }
}

describe('historical methodology replay', () => {
  const golden = JSON.parse(readFileSync(
    new URL('../fixtures/replay/latest-ledger-methodology-history-v1.json', import.meta.url),
    'utf8',
  )) as unknown[]

  it('preserves deterministic results for every retained methodology version', () => {
    const replay = [methodologyV14, methodologyV15].map((methodology) => {
      const result = reconcileMetric({
        snapshotId: `snapshot-${methodology.version}`,
        cycleId: 'historical-cycle',
        subject: { kind: 'network', network },
        configuredSources: sources,
        observations,
        clock: () => new Date(now),
        methodology: executableMethodology(methodology),
        profile,
      })
      return {
        methodology_version: result.snapshot.methodologyVersion,
        confidence_formula_version: result.snapshot.confidence.formulaVersion,
        status: result.snapshot.status,
        confidence: result.snapshot.confidence.score,
        caps: result.snapshot.confidence.capsApplied,
      }
    })

    expect(replay).toEqual(golden)
  })
})
