import { z } from 'zod'
import { SUPPLY_METHODOLOGY_VERSION } from '../../config/methodology'
import {
  assetIdSchema,
  circulatingSupplyObservationSchema,
  creditAssetSchema,
  identifierSchema,
  networkIdentitySchema,
  sourceIdentitySchema,
  type AssetId,
  type NetworkIdentity,
  type RawObservation,
  type SourceIdentity,
} from '../contracts/domain'
import { computeEvidenceSha256 } from '../evidence/json'
import { parseStellarAmount } from './amount'
import {
  DEFAULT_HORIZON_MAX_RESPONSE_BYTES,
  DEFAULT_HORIZON_TIMEOUT_MS,
  HorizonResponseTooLargeError,
  assertHorizonEndpointAllowed,
  parseRetryAfter,
  readBoundedHorizonJson,
  type HorizonEndpointPolicy,
} from './horizon'

export const ARCHIVE_SUPPLY_CONNECTOR_VERSION = 'archive-supply-v0.1' as const
export const ARCHIVE_SUPPLY_ARTIFACT_VERSION = 'onchain-supply-archive-replay-v1' as const

const amountStringSchema = z.string().regex(/^(0|[1-9]\d*)\.\d{7}$/)
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/)
const trustedCheckpointSchema = z.object({
  ledgerSequence: z.number().int().safe().positive(),
  ledgerHash: hashSchema,
  artifactSha256: hashSchema,
  provenance: z.object({
    manifestId: identifierSchema,
    source: z.string().url(),
    verificationMethod: z.enum(['trusted_manifest_signature', 'stellar_core_extra_verification']),
    verificationEvidenceSha256: hashSchema,
    verifiedAt: z.string().datetime({ offset: true }),
  }).strict(),
}).strict()
const artifactComponentsSchema = z.object({
  authorized_trustlines: amountStringSchema,
  maintain_liabilities_trustlines: amountStringSchema,
  unauthorized_trustlines: amountStringSchema,
  claimable_balances: amountStringSchema,
  liquidity_pools: amountStringSchema,
  contract_balances: amountStringSchema,
}).strict()

const archiveArtifactSchema = z.object({
  schema_version: z.literal(ARCHIVE_SUPPLY_ARTIFACT_VERSION),
  methodology_version: z.literal(SUPPLY_METHODOLOGY_VERSION),
  network: networkIdentitySchema,
  asset: creditAssetSchema,
  ledger: z.object({
    sequence: z.number().int().safe().positive(),
    closed_at: z.string().datetime({ offset: true }),
    hash: hashSchema,
  }).strict(),
  components: artifactComponentsSchema,
  total: amountStringSchema,
  derivation: z.object({
    family: z.literal('history_archive_state_replay'),
    replay_tool: z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(100) }).strict(),
    stellar_core_version: z.string().min(1).max(100),
    replay_start_ledger: z.number().int().safe().positive(),
    replay_end_ledger: z.number().int().safe().positive(),
    trusted_ledger_hash: hashSchema,
    bucket_list_hash: hashSchema,
    history_archive_state_sha256: hashSchema,
  }).strict(),
  generated_at: z.string().datetime({ offset: true }),
}).strict()

export type RawSupplyObservation = Extract<RawObservation, { metric: 'circulating_supply' }>

export type ArchiveSupplyErrorCode =
  | 'invalid_asset'
  | 'invalid_configuration'
  | 'request_failed'
  | 'request_aborted'
  | 'non_200_response'
  | 'redirect_rejected'
  | 'response_too_large'
  | 'malformed_payload'
  | 'network_mismatch'
  | 'checkpoint_mismatch'
  | 'artifact_integrity_mismatch'
  | 'total_mismatch'

export interface ArchiveSupplyError {
  sourceId: string
  sourceUrl: string
  code: ArchiveSupplyErrorCode
  message: string
  retrievedAt: string
  status?: number
  retryAfterMs?: number
}

export interface ArchiveSupplyRequestEvidence {
  url: string
  status: number
  startedAt: string
  completedAt: string
  payloadSha256: string
}

export type ArchiveSupplyResult =
  | {
      observation: RawSupplyObservation
      evidence: { rawPayload: z.infer<typeof archiveArtifactSchema>; request: ArchiveSupplyRequestEvidence }
      error?: never
    }
  | { observation?: never; evidence?: never; error: ArchiveSupplyError }

function timestamp(clock: () => Date) {
  const value = clock()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('clock must return a valid Date')
  return value.toISOString()
}

function archiveError(
  source: SourceIdentity,
  code: ArchiveSupplyErrorCode,
  message: string,
  retrievedAt: string,
  extras: Pick<ArchiveSupplyError, 'status' | 'retryAfterMs'> | Record<string, never> = {},
): ArchiveSupplyResult {
  return { error: { sourceId: source.id, sourceUrl: source.url, code, message, retrievedAt, ...extras } }
}

function exactComponents(components: z.infer<typeof artifactComponentsSchema>) {
  return {
    authorized_trustlines: parseStellarAmount(components.authorized_trustlines),
    maintain_liabilities_trustlines: parseStellarAmount(components.maintain_liabilities_trustlines),
    unauthorized_trustlines: parseStellarAmount(components.unauthorized_trustlines),
    claimable_balances: parseStellarAmount(components.claimable_balances),
    liquidity_pools: parseStellarAmount(components.liquidity_pools),
    contract_balances: parseStellarAmount(components.contract_balances),
  }
}

export async function fetchArchiveSupplyObservation({
  observationId,
  cycleId,
  source: sourceInput,
  asset: assetInput,
  expectedNetwork: networkInput,
  trustedCheckpoint: trustedCheckpointInput,
  fetchImpl = fetch,
  clock = () => new Date(),
  signal,
  endpointPolicy = {},
  timeoutMs = DEFAULT_HORIZON_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_HORIZON_MAX_RESPONSE_BYTES,
}: {
  observationId: string
  cycleId: string
  source: SourceIdentity | unknown
  asset: AssetId | unknown
  expectedNetwork: NetworkIdentity | unknown
  trustedCheckpoint: unknown
  fetchImpl?: typeof fetch
  clock?: () => Date
  signal?: AbortSignal
  endpointPolicy?: HorizonEndpointPolicy
  timeoutMs?: number
  maxResponseBytes?: number
}): Promise<ArchiveSupplyResult> {
  const requestedAt = timestamp(clock)
  const parsedAsset = assetIdSchema.safeParse(assetInput)
  if (!parsedAsset.success || parsedAsset.data.kind !== 'credit') {
    const fallback = sourceIdentitySchema.safeParse(sourceInput)
    const source = fallback.success ? fallback.data : {
      id: 'invalid_source',
      url: 'https://invalid.example',
      sourceClass: 'archive' as const,
      adapter: 'archive' as const,
      network: { id: 'standalone' as const, passphrase: 'invalid' },
    }
    return archiveError(source, 'invalid_asset', 'Archive supply requires a valid classic credit asset', requestedAt)
  }
  const asset = parsedAsset.data

  let source: SourceIdentity
  let expectedNetwork: NetworkIdentity
  let endpointUrl: URL
  let trustedCheckpoint: z.infer<typeof trustedCheckpointSchema>
  try {
    source = sourceIdentitySchema.parse(sourceInput)
    expectedNetwork = networkIdentitySchema.parse(networkInput)
    trustedCheckpoint = trustedCheckpointSchema.parse(trustedCheckpointInput)
    identifierSchema.parse(observationId)
    identifierSchema.parse(cycleId)
    if (source.adapter !== 'archive' || source.sourceClass !== 'archive') {
      throw new Error('archive replay evidence requires the archive adapter and source class')
    }
    if (
      source.network.id !== expectedNetwork.id ||
      source.network.passphrase !== expectedNetwork.passphrase
    ) {
      throw new Error('archive source network does not match the requested network')
    }
    endpointUrl = new URL(source.url)
    if (!['http:', 'https:'].includes(endpointUrl.protocol)) throw new Error('archive evidence URL must use HTTP or HTTPS')
    assertHorizonEndpointAllowed(endpointUrl, endpointPolicy)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be greater than zero')
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw new Error('maxResponseBytes must be a positive safe integer')
    }
  } catch (error) {
    const fallback = sourceIdentitySchema.safeParse(sourceInput)
    const sourceForError = fallback.success ? fallback.data : {
      id: 'invalid_source',
      url: 'https://invalid.example',
      sourceClass: 'archive' as const,
      adapter: 'archive' as const,
      network: { id: 'standalone' as const, passphrase: 'invalid' },
    }
    return archiveError(
      sourceForError,
      'invalid_configuration',
      error instanceof Error ? error.message : 'archive connector configuration is invalid',
      requestedAt,
    )
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = timestamp(clock)
  try {
    const response = await fetchImpl(endpointUrl.toString(), {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'error',
    })
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      return archiveError(source, 'redirect_rejected', 'archive evidence request redirected', timestamp(clock))
    }
    if (!response.ok) {
      const completedAt = timestamp(clock)
      return archiveError(
        source,
        'non_200_response',
        `archive evidence endpoint returned HTTP ${response.status}`,
        completedAt,
        {
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), completedAt),
        },
      )
    }

    let payload: unknown
    try {
      payload = await readBoundedHorizonJson(response, maxResponseBytes)
    } catch (error) {
      if (signal?.aborted) throw error
      const aborted = error instanceof Error && error.name === 'AbortError'
      return archiveError(
        source,
        aborted ? 'request_aborted' : error instanceof HorizonResponseTooLargeError ? 'response_too_large' : 'malformed_payload',
        aborted
          ? `archive evidence request exceeded ${timeoutMs}ms`
          : error instanceof HorizonResponseTooLargeError
            ? `archive evidence exceeded ${maxResponseBytes} bytes`
            : 'archive evidence was not valid JSON',
        timestamp(clock),
      )
    }
    const completedAt = timestamp(clock)
    const payloadSha256 = computeEvidenceSha256(payload)
    if (payloadSha256 !== trustedCheckpoint.artifactSha256) {
      return archiveError(
        source,
        'artifact_integrity_mismatch',
        'archive artifact does not match the independently trusted manifest digest',
        completedAt,
      )
    }
    const parsedArtifact = archiveArtifactSchema.safeParse(payload)
    if (!parsedArtifact.success) {
      return archiveError(source, 'malformed_payload', 'archive replay artifact is incomplete or malformed', completedAt)
    }
    const artifact = parsedArtifact.data
    if (
      artifact.network.id !== expectedNetwork.id ||
      artifact.network.passphrase !== expectedNetwork.passphrase
    ) {
      return archiveError(source, 'network_mismatch', 'archive artifact network does not match the requested network', completedAt)
    }
    if (artifact.asset.code !== asset.code || artifact.asset.issuer !== asset.issuer) {
      return archiveError(source, 'invalid_asset', 'archive artifact does not match the requested asset', completedAt)
    }
    if (
      artifact.derivation.replay_start_ledger > artifact.derivation.replay_end_ledger ||
      artifact.derivation.replay_end_ledger !== artifact.ledger.sequence ||
      artifact.derivation.trusted_ledger_hash !== artifact.ledger.hash ||
      artifact.ledger.sequence !== trustedCheckpoint.ledgerSequence ||
      artifact.ledger.hash !== trustedCheckpoint.ledgerHash
    ) {
      return archiveError(source, 'checkpoint_mismatch', 'archive replay checkpoint does not match its ledger', completedAt)
    }
    if (
      Date.parse(artifact.generated_at) < Date.parse(artifact.ledger.closed_at) ||
      Date.parse(artifact.generated_at) > Date.parse(completedAt)
    ) {
      return archiveError(source, 'malformed_payload', 'archive artifact generation time is inconsistent', completedAt)
    }

    const components = exactComponents(artifact.components)
    const amount = Object.values(components).reduce(
      (sum, component) => sum.add(component),
      parseStellarAmount('0'),
    )
    if (!amount.equals(parseStellarAmount(artifact.total))) {
      return archiveError(source, 'total_mismatch', 'archive total does not equal its exact component sum', completedAt)
    }
    const observation = circulatingSupplyObservationSchema.parse({
      observationId,
      cycleId,
      metric: 'circulating_supply',
      asset,
      amount,
      components,
      ledgerSequence: artifact.ledger.sequence,
      methodologyVersion: SUPPLY_METHODOLOGY_VERSION,
      provenance: {
        source,
        sourceTimestamp: artifact.ledger.closed_at,
        retrievedAt: completedAt,
      },
      derivation: {
        family: 'history_archive_state_replay',
        connectorVersion: ARCHIVE_SUPPLY_CONNECTOR_VERSION,
        evidenceSha256: payloadSha256,
        software: {
          name: artifact.derivation.replay_tool.name,
          version: artifact.derivation.replay_tool.version,
          stellarCoreVersion: artifact.derivation.stellar_core_version,
        },
        checkpoint: {
          kind: 'history_archive_replay',
          ledgerSequence: artifact.ledger.sequence,
          ledgerHash: artifact.ledger.hash,
          trustedLedgerHash: artifact.derivation.trusted_ledger_hash,
          bucketListHash: artifact.derivation.bucket_list_hash,
          historyArchiveStateSha256: artifact.derivation.history_archive_state_sha256,
          trustedArtifactSha256: trustedCheckpoint.artifactSha256,
          trustProvenance: trustedCheckpoint.provenance,
          replayStartLedger: artifact.derivation.replay_start_ledger,
          replayEndLedger: artifact.derivation.replay_end_ledger,
        },
      },
    })
    return {
      observation,
      evidence: {
        rawPayload: artifact,
        request: {
          url: endpointUrl.toString(),
          status: response.status,
          startedAt,
          completedAt,
          payloadSha256,
        },
      },
    }
  } catch (error) {
    if (signal?.aborted) throw error
    const aborted = error instanceof Error && error.name === 'AbortError'
    return archiveError(
      source,
      aborted ? 'request_aborted' : 'request_failed',
      aborted ? `archive evidence request exceeded ${timeoutMs}ms` : 'archive evidence request failed',
      timestamp(clock),
    )
  } finally {
    clearTimeout(timeout)
  }
}
