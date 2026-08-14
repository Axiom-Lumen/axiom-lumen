import {
  circulatingSupplyObservationSchema,
  formatAssetId,
  identifierSchema,
  type RawObservation,
} from '../contracts/domain'
import { computeEvidenceSha256 } from '../evidence/json'
import {
  fetchHorizonOnchainAssetSupply,
  type HorizonSupplyFetchOptions,
  type HorizonSupplyObservation,
  type HorizonSupplyResult,
} from './horizon-supply'

export type RawSupplyObservation = Extract<RawObservation, { metric: 'circulating_supply' }>

export interface SupplyEvidenceAssessment {
  statusCeiling: 'verified' | 'degraded' | 'unavailable'
  reason:
    | 'no_observations'
    | 'incompatible_asset'
    | 'incompatible_network'
    | 'incompatible_ledger'
    | 'incompatible_cycle'
    | 'incompatible_source_timestamp'
    | 'insufficient_independent_derivations'
    | 'independent_derivations_disagree'
    | 'verification_eligible'
  eligibleDerivationFamilies: RawSupplyObservation['derivation']['family'][]
}

export function assessSupplyEvidence(observationInputs: readonly unknown[]): SupplyEvidenceAssessment {
  const observations = observationInputs.map((observation) => circulatingSupplyObservationSchema.parse(observation))
  if (observations.length === 0) {
    return { statusCeiling: 'unavailable', reason: 'no_observations', eligibleDerivationFamilies: [] }
  }
  const reference = observations[0]!
  const eligibleDerivationFamilies = [...new Set(observations.map((observation) => observation.derivation.family))]
    .sort() as RawSupplyObservation['derivation']['family'][]
  const degraded = (reason: SupplyEvidenceAssessment['reason']): SupplyEvidenceAssessment =>
    ({ statusCeiling: 'degraded', reason, eligibleDerivationFamilies })
  if (observations.some((observation) => formatAssetId(observation.asset) !== formatAssetId(reference.asset))) {
    return degraded('incompatible_asset')
  }
  if (observations.some((observation) =>
    observation.provenance.source.network.id !== reference.provenance.source.network.id ||
    observation.provenance.source.network.passphrase !== reference.provenance.source.network.passphrase
  )) return degraded('incompatible_network')
  if (observations.some((observation) => observation.ledgerSequence !== reference.ledgerSequence)) {
    return degraded('incompatible_ledger')
  }
  if (observations.some((observation) => observation.cycleId !== reference.cycleId)) {
    return degraded('incompatible_cycle')
  }
  if (observations.some((observation) =>
    Date.parse(observation.provenance.sourceTimestamp!) !== Date.parse(reference.provenance.sourceTimestamp!)
  )) return degraded('incompatible_source_timestamp')
  if (eligibleDerivationFamilies.length < 2) {
    return {
      statusCeiling: 'degraded',
      reason: 'insufficient_independent_derivations',
      eligibleDerivationFamilies,
    }
  }
  const componentIds = Object.keys(reference.components) as (keyof RawSupplyObservation['components'])[]
  if (observations.some((observation) =>
    !observation.amount.equals(reference.amount) ||
    componentIds.some((component) => !observation.components[component].equals(reference.components[component]))
  )) {
    return {
      statusCeiling: 'degraded',
      reason: 'independent_derivations_disagree',
      eligibleDerivationFamilies,
    }
  }
  return { statusCeiling: 'verified', reason: 'verification_eligible', eligibleDerivationFamilies }
}

export type HorizonRawSupplyResult =
  | { observation: RawSupplyObservation; evidence: unknown; error?: never }
  | { observation?: never; error: Extract<HorizonSupplyResult, { error: unknown }>['error'] }

export async function fetchHorizonRawSupplyObservation({
  observationId,
  cycleId,
  ...options
}: HorizonSupplyFetchOptions & { observationId: string; cycleId: string }): Promise<HorizonRawSupplyResult> {
  identifierSchema.parse(observationId)
  identifierSchema.parse(cycleId)
  const result = await fetchHorizonOnchainAssetSupply(options)
  if (result.error) return { error: result.error }
  const evidence = {
    rawPayload: result.observation.rawPayload,
    requestProvenance: result.observation.requestProvenance,
    pageMetadata: result.observation.pageMetadata,
  }
  return {
    observation: toHorizonRawSupplyObservation({ observationId, cycleId, observation: result.observation }),
    evidence,
  }
}

export function toHorizonRawSupplyObservation({
  observationId,
  cycleId,
  observation,
}: {
  observationId: string
  cycleId: string
  observation: HorizonSupplyObservation
}): RawSupplyObservation {
  const evidence = {
    rawPayload: observation.rawPayload,
    requestProvenance: observation.requestProvenance,
    pageMetadata: observation.pageMetadata,
  }
  return circulatingSupplyObservationSchema.parse({
    observationId: identifierSchema.parse(observationId),
    cycleId: identifierSchema.parse(cycleId),
    metric: 'circulating_supply',
    asset: observation.asset,
    amount: observation.amount,
    components: observation.components,
    ledgerSequence: observation.ledgerSequence,
    methodologyVersion: observation.methodologyVersion,
    provenance: {
      source: observation.source,
      sourceTimestamp: observation.sourceTimestamp,
      retrievedAt: observation.retrievedAt,
    },
    derivation: {
      family: 'horizon_asset_aggregate',
      connectorVersion: observation.connectorVersion,
      evidenceSha256: computeEvidenceSha256(evidence),
      software: { name: 'stellar-horizon', version: null },
      checkpoint: {
        kind: 'horizon_asset_page',
        ledgerSequence: observation.ledgerSequence,
        terminalCursor: observation.pageMetadata.terminalCursor,
        pagesScanned: observation.pageMetadata.pagesScanned,
        recordsScanned: observation.pageMetadata.recordsScanned,
      },
    },
  })
}
