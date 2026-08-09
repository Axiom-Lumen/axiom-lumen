import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SOURCE_CLASS_IDS, methodologyConfig } from '../../config/methodology'
import {
  circulatingSupplyObservationSchema,
  latestLedgerObservationSchema,
  type SourceError,
  type SourceIdentity,
} from '../../lib/contracts/domain'
import {
  reconcileMetric,
  type MetricReconciliationProfile,
  type ReconciliationMethodologyConfig,
} from '../../lib/reconcile/orchestrator'
import {
  classifySafeIntegerDeviationBand,
  classifyStellarAmountDeviationBand,
} from '../../lib/reconcile/discrepancy-state'
import { absoluteDelta, parseStellarAmount, type StellarAmount } from '../../lib/stellar/amount'

const NOW = new Date('2026-08-09T12:10:00.000Z')
const NETWORK = {
  id: 'public' as const,
  passphrase: 'Public Global Stellar Network ; September 2015',
}

function source(id: string, sourceClass: SourceIdentity['sourceClass'] = 'canonical_ledger'): SourceIdentity {
  const adapter = sourceClass === 'anchor_self_reported' ? ('anchor' as const) : ('horizon' as const)
  return { id, sourceClass, adapter, url: `https://${id}.example/`, network: NETWORK }
}

function ledgerObservation(
  sourceIdentity: SourceIdentity,
  ledgerSequence: number,
  { cycleId = 'cycle-1', sourceTimestamp = NOW.toISOString() }: { cycleId?: string; sourceTimestamp?: string } = {},
) {
  return {
    observationId: `obs-${cycleId}-${sourceIdentity.id}`,
    cycleId,
    metric: 'latest_ledger' as const,
    ledgerSequence,
    provenance: {
      source: sourceIdentity,
      sourceTimestamp,
      retrievedAt: NOW.toISOString(),
    },
  }
}

function sourceError(sourceIdentity: SourceIdentity, code: SourceError['code']): SourceError {
  const category = code === 'network_mismatch' ? ('network' as const) : ('transport' as const)
  return {
    sourceId: sourceIdentity.id,
    sourceUrl: sourceIdentity.url,
    code,
    category,
    message: code === 'network_mismatch' ? 'Network mismatch' : 'Request failed',
    occurredAt: NOW.toISOString(),
    retryable: code !== 'network_mismatch',
  }
}

const confidence = methodologyConfig.metrics.latestLedger.confidence
const methodology: ReconciliationMethodologyConfig = {
  version: methodologyConfig.version,
  freshnessHalfLifeSeconds: methodologyConfig.metrics.latestLedger.freshnessHalfLifeSeconds,
  expectedSourceClasses: ['canonical_ledger'],
  sourceClassBaseWeights: Object.fromEntries(
    SOURCE_CLASS_IDS.map((sourceClass) => [sourceClass, methodologyConfig.sourceClasses[sourceClass].baseWeight]),
  ) as ReconciliationMethodologyConfig['sourceClassBaseWeights'],
  minimumVerifiedSources: methodologyConfig.metrics.latestLedger.minimumVerifiedSources,
  verifiedThreshold: confidence.verifiedThreshold,
  confidenceFormulaVersion: confidence.formulaVersion,
  confidenceCoefficients: {
    agreement: confidence.agreementCoefficient,
    freshness: confidence.freshnessCoefficient,
    availability: confidence.availabilityCoefficient,
    spread: confidence.spreadCoefficient,
  },
  singleSourceCap: confidence.singleSourceCap,
  sameUpstreamCap: confidence.sameUpstreamCap,
  sourceErrorCap: confidence.sourceErrorCap,
}

const ledgerProfile: MetricReconciliationProfile<ReturnType<typeof latestLedgerObservationSchema.parse>, number> = {
  metric: 'latest_ledger',
  parseObservation: (input) => latestLedgerObservationSchema.parse(input),
  matchesSubject: (observation, subject) =>
    subject.kind === 'network' &&
    observation.provenance.source.network.id === subject.network.id &&
    observation.provenance.source.network.passphrase === subject.network.passphrase,
  getValue: (observation) => observation.ledgerSequence,
  compareValues: (left, right) => left - right,
  agrees: (observed, reference) => Math.abs(observed - reference) <= 1,
  deviationBand: (observed, reference) =>
    classifySafeIntegerDeviationBand({ absoluteDeviation: Math.abs(observed - reference), tolerance: 1 }),
  spreadDistance: (observed, reference) => Math.abs(observed - reference),
  maximumSpreadDistance: confidence.maximumSpreadLedgers,
  toMetricValue: (value) => ({ kind: 'ledger', value }),
}

type GoldenName = 'verified' | 'degraded' | 'unavailable' | 'stale' | 'split-network' | 'outlier'

interface GoldenFixture {
  name: GoldenName
  expected: {
    status: string
    value: number | null
    confidence: number
    sources_configured: number
    sources_responded: number
    sources_usable: number
    sources_agreeing: number
    sources_excluded: number
    caps: string[]
    discrepancy_severities: string[]
    event_types: string[]
  }
}

function goldenInput(name: GoldenName) {
  const a = source('source-a')
  const b = source('source-b')
  const c = source('source-c')
  const staleAt = new Date(NOW.getTime() - 600_000).toISOString()
  switch (name) {
    case 'verified':
      return { configuredSources: [a, b], observations: [ledgerObservation(a, 100), ledgerObservation(b, 100)] }
    case 'degraded':
      return {
        configuredSources: [a, b, c],
        observations: [ledgerObservation(a, 100), ledgerObservation(b, 100)],
        sourceErrors: [sourceError(c, 'request_failed')],
      }
    case 'unavailable':
      return {
        configuredSources: [a, b],
        observations: [],
        sourceErrors: [sourceError(a, 'request_failed'), sourceError(b, 'request_failed')],
      }
    case 'stale':
      return {
        configuredSources: [a, b],
        observations: [
          ledgerObservation(a, 100, { sourceTimestamp: staleAt }),
          ledgerObservation(b, 100, { sourceTimestamp: staleAt }),
        ],
      }
    case 'split-network':
      return {
        configuredSources: [a, b],
        observations: [ledgerObservation(a, 100), ledgerObservation(b, 140)],
        sourceErrors: [sourceError(b, 'network_mismatch')],
      }
    case 'outlier':
      return {
        configuredSources: [a, b, c],
        observations: [ledgerObservation(a, 100), ledgerObservation(b, 100), ledgerObservation(c, 140)],
      }
  }
}

function runLedger(name: GoldenName) {
  return reconcileMetric({
    snapshotId: `snapshot-${name}`,
    cycleId: 'cycle-1',
    subject: { kind: 'network', network: NETWORK },
    clock: () => new Date(NOW),
    methodology,
    profile: ledgerProfile,
    ...goldenInput(name),
  })
}

describe('metric reconciliation orchestrator', () => {
  const fixturePath = fileURLToPath(
    new URL('../fixtures/reconciliation/orchestrator-golden-v1.json', import.meta.url),
  )
  const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')) as GoldenFixture[]

  for (const fixture of fixtures) {
    it(`matches the ${fixture.name} golden fixture`, () => {
      const result = runLedger(fixture.name)
      const summary = {
        status: result.snapshot.status,
        value: result.snapshot.value?.kind === 'ledger' ? result.snapshot.value.value : null,
        confidence: result.snapshot.confidence.score,
        sources_configured: result.snapshot.sourcesConfigured,
        sources_responded: result.snapshot.sourcesResponded,
        sources_usable: result.snapshot.sourcesUsable,
        sources_agreeing: result.snapshot.sourcesAgreeing,
        sources_excluded: result.snapshot.sourcesExcluded,
        caps: result.snapshot.confidence.capsApplied,
        discrepancy_severities: result.snapshot.discrepancies.map((item) => item.severity),
        event_types: result.events.map((event) => event.type),
      }

      expect(summary).toEqual(fixture.expected)
    })
  }

  it('produces byte-equivalent immutable output for identical inputs, clock, state, and methodology', () => {
    const first = runLedger('outlier')
    const second = runLedger('outlier')

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.snapshot)).toBe(true)
    expect(Object.isFrozen(first.snapshot.contributions)).toBe(true)
    expect(() => first.snapshot.contributions.reverse()).toThrow()
  })

  it('resolves prior discrepancy state through append-only events', () => {
    const first = runLedger('outlier')
    const prior = first.discrepancyStates['source-c']
    if (!prior) throw new Error('expected prior discrepancy')
    const sources = [source('source-a'), source('source-b'), source('source-c')]
    const second = reconcileMetric({
      snapshotId: 'snapshot-resolved',
      cycleId: 'cycle-2',
      subject: { kind: 'network', network: NETWORK },
      configuredSources: sources,
      observations: sources.map((item) => ledgerObservation(item, 100, { cycleId: 'cycle-2' })),
      priorDiscrepancyStates: { 'source-c': prior },
      clock: () => new Date(NOW.getTime() + 30_000),
      methodology,
      profile: ledgerProfile,
    })

    expect(second.events.map((event) => event.type)).toEqual(['reconverged', 'resolved'])
    expect(second.discrepancyStates['source-c']).toMatchObject({ lifecycleState: 'resolved', consecutiveCycles: 0 })
    expect(second.snapshot.discrepancies).toHaveLength(1)
    expect(second.snapshot.discrepancies[0]?.lifecycleState).toBe('resolved')
  })

  it('rejects invalid boundary input without returning a partial snapshot', () => {
    const configured = source('source-a')
    const invalid = { ...ledgerObservation(configured, 100), ledgerSequence: Number.NaN }

    expect(() =>
      reconcileMetric({
        snapshotId: 'snapshot-invalid',
        cycleId: 'cycle-1',
        subject: { kind: 'network', network: NETWORK },
        configuredSources: [configured],
        observations: [invalid],
        clock: () => new Date(NOW),
        methodology,
        profile: ledgerProfile,
      }),
    ).toThrow()
  })

  it('rejects subject mismatches before reconciliation', () => {
    const configured = source('source-a')

    expect(() =>
      reconcileMetric({
        snapshotId: 'snapshot-subject-mismatch',
        cycleId: 'cycle-1',
        subject: { kind: 'network', network: { id: 'testnet', passphrase: 'Test SDF Network ; September 2015' } },
        configuredSources: [configured],
        observations: [ledgerObservation(configured, 100)],
        clock: () => new Date(NOW),
        methodology,
        profile: ledgerProfile,
      }),
    ).toThrow(/does not match the requested subject/)
  })

  it('validates methodology even when the result would be unavailable', () => {
    expect(() =>
      reconcileMetric({
        snapshotId: 'snapshot-invalid-methodology',
        cycleId: 'cycle-1',
        subject: { kind: 'network', network: NETWORK },
        configuredSources: [],
        observations: [],
        clock: () => new Date(NOW),
        methodology: {
          ...methodology,
          confidenceCoefficients: { ...methodology.confidenceCoefficients, agreement: 0.4 },
        },
        profile: ledgerProfile,
      }),
    ).toThrow(/coefficients must sum to 1/)
  })

  it('preserves prior open state when every current source is unavailable', () => {
    const first = runLedger('outlier')
    const prior = first.discrepancyStates['source-c']
    if (!prior) throw new Error('expected prior discrepancy')
    const sources = [source('source-a'), source('source-b'), source('source-c')]
    const result = reconcileMetric({
      snapshotId: 'snapshot-all-failed',
      cycleId: 'cycle-2',
      subject: { kind: 'network', network: NETWORK },
      configuredSources: sources,
      observations: [],
      sourceErrors: sources.map((item) => sourceError(item, 'request_failed')),
      priorDiscrepancyStates: { 'source-c': prior },
      clock: () => new Date(NOW.getTime() + 30_000),
      methodology,
      profile: ledgerProfile,
    })

    expect(result.snapshot.status).toBe('unavailable')
    expect(result.discrepancyStates['source-c']).toEqual(prior)
    expect(result.events).toEqual([])
  })

  it('rejects an orchestrator cycle that does not follow prior finalized state', () => {
    const first = runLedger('outlier')
    const prior = first.discrepancyStates['source-c']
    if (!prior) throw new Error('expected prior discrepancy')
    const sources = [source('source-a'), source('source-b'), source('source-c')]

    expect(() =>
      reconcileMetric({
        snapshotId: 'snapshot-duplicate-cycle',
        cycleId: 'cycle-1',
        subject: { kind: 'network', network: NETWORK },
        configuredSources: sources,
        observations: sources.map((item) => ledgerObservation(item, 100)),
        priorDiscrepancyStates: { 'source-c': prior },
        clock: () => new Date(NOW),
        methodology,
        profile: ledgerProfile,
      }),
    ).toThrow(/duplicate cycle/)
  })

  it('accepts a maximum-length observation ID when opening a discrepancy', () => {
    const sources = [source('source-a'), source('source-b'), source('source-c')]
    const longId = `o${'a'.repeat(127)}`
    const outlier = { ...ledgerObservation(sources[2]!, 140), observationId: longId }
    const result = reconcileMetric({
      snapshotId: 'snapshot-long-observation-id',
      cycleId: 'cycle-1',
      subject: { kind: 'network', network: NETWORK },
      configuredSources: sources,
      observations: [ledgerObservation(sources[0]!, 100), ledgerObservation(sources[1]!, 100), outlier],
      clock: () => new Date(NOW),
      methodology,
      profile: ledgerProfile,
    })

    expect(result.discrepancyStates['source-c']?.discrepancyId).toBe(longId)
  })

  it('normalizes upstream IDs before applying the replica cap', () => {
    const sources = [source('source-a'), source('source-b')]
    const profile: typeof ledgerProfile = {
      ...ledgerProfile,
      getUpstreamId: (observation) =>
        observation.provenance.source.id === 'source-a' ? 'shared-upstream' : ' shared-upstream ',
    }
    const result = reconcileMetric({
      snapshotId: 'snapshot-shared-upstream',
      cycleId: 'cycle-1',
      subject: { kind: 'network', network: NETWORK },
      configuredSources: sources,
      observations: sources.map((item) => ledgerObservation(item, 100)),
      clock: () => new Date(NOW),
      methodology,
      profile,
    })

    expect(result.snapshot.confidence.score).toBeLessThanOrEqual(methodology.sameUpstreamCap)
    expect(result.snapshot.confidence.capsApplied).toContain('same_upstream_replicas')
  })

  it('supports decimal-safe amount profiles without coercing values to numbers', () => {
    const canonical = source('canonical')
    const anchor = source('anchor', 'anchor_self_reported')
    const asset = { kind: 'native' as const }
    const amount = parseStellarAmount('9007199254740993.0000001')
    const tolerance = parseStellarAmount('0.0000001')
    const amountObservation = (sourceIdentity: SourceIdentity, value: string) => ({
      observationId: `obs-${sourceIdentity.id}`,
      cycleId: 'cycle-amount',
      metric: 'circulating_supply' as const,
      asset,
      amount: value,
      provenance: { source: sourceIdentity, sourceTimestamp: NOW.toISOString(), retrievedAt: NOW.toISOString() },
    })
    const amountProfile: MetricReconciliationProfile<
      ReturnType<typeof circulatingSupplyObservationSchema.parse>,
      StellarAmount
    > = {
      metric: 'circulating_supply',
      parseObservation: (input) => circulatingSupplyObservationSchema.parse(input),
      matchesSubject: (observation, subject) =>
        subject.kind === 'asset' && observation.asset.kind === subject.asset.kind,
      getValue: (observation) => observation.amount,
      compareValues: (left, right) => left.compare(right),
      agrees: (observed, reference) => absoluteDelta(observed, reference).compare(tolerance) <= 0,
      deviationBand: (observed, reference) =>
        classifyStellarAmountDeviationBand({ absoluteDeviation: absoluteDelta(observed, reference), tolerance }),
      spreadDistance: (observed, reference) =>
        Number(absoluteDelta(observed, reference).toStroops() > 2n ? 2n : absoluteDelta(observed, reference).toStroops()),
      maximumSpreadDistance: 2,
      toMetricValue: (value) => ({ kind: 'amount', value }),
    }
    const result = reconcileMetric({
      snapshotId: 'snapshot-amount',
      cycleId: 'cycle-amount',
      subject: { kind: 'asset', asset },
      configuredSources: [canonical, anchor],
      observations: [
        amountObservation(canonical, amount.toString()),
        amountObservation(anchor, '9007199254740993.0000002'),
      ],
      clock: () => new Date(NOW),
      methodology: { ...methodology, expectedSourceClasses: ['canonical_ledger', 'anchor_self_reported'] },
      profile: amountProfile,
    })

    expect(result.snapshot.value?.kind).toBe('amount')
    expect(result.snapshot.value?.value.toString()).toBe(amount.toString())
  })
})
