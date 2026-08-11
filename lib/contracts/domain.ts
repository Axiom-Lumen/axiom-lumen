import { z } from 'zod'
import {
  DEPTH_METHODOLOGY_VERSION,
  DEPTH_PRICE_BANDS_BPS,
  SOURCE_CLASS_IDS,
  SUPPLY_COMPONENT_IDS,
  SUPPLY_METHODOLOGY_VERSION,
  TRUSTLINE_METHODOLOGY_VERSION,
  TRUSTLINE_STATE_IDS,
} from '../../config/methodology'
import { StellarAmount, parseStellarAmount } from '../stellar/amount'

export const identifierSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)

export const utcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())

export const networkIdSchema = z.enum(['public', 'testnet', 'futurenet', 'standalone'])

export const networkIdentitySchema = z
  .object({
    id: networkIdSchema,
    passphrase: z.string().trim().min(1).max(255),
  })
  .strict()
  .superRefine((network, context) => {
    const knownPassphrases: Partial<Record<z.infer<typeof networkIdSchema>, string>> = {
      public: 'Public Global Stellar Network ; September 2015',
      testnet: 'Test SDF Network ; September 2015',
    }
    const expected = knownPassphrases[network.id]
    if (expected && network.passphrase !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['passphrase'],
        message: `network passphrase does not match ${network.id}`,
      })
    }
  })
export type NetworkIdentity = z.infer<typeof networkIdentitySchema>

export const stellarAccountIdSchema = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, 'issuer must be a canonical Stellar G-address')

export const nativeAssetSchema = z.object({ kind: z.literal('native') }).strict()

export const creditAssetSchema = z
  .object({
    kind: z.literal('credit'),
    code: z.string().regex(/^[A-Z0-9]{1,12}$/, 'asset code must contain 1–12 uppercase letters or digits'),
    issuer: stellarAccountIdSchema,
  })
  .strict()

export const assetIdSchema = z.discriminatedUnion('kind', [nativeAssetSchema, creditAssetSchema])
export type AssetId = z.infer<typeof assetIdSchema>

export function parseAssetId(value: unknown): AssetId {
  if (typeof value !== 'string') return assetIdSchema.parse(value)
  if (value.toLowerCase() === 'native') return { kind: 'native' }

  const parts = value.split(':')
  if (parts.length !== 2) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'asset must be native or CODE:ISSUER',
      },
    ])
  }
  return assetIdSchema.parse({ kind: 'credit', code: parts[0], issuer: parts[1] })
}

export function formatAssetId(asset: AssetId) {
  return asset.kind === 'native' ? 'native' : `${asset.code}:${asset.issuer}`
}

export function formatNetworkAssetKey(networkId: NetworkIdentity['id'], asset: AssetId) {
  return `${networkIdSchema.parse(networkId)}:${formatAssetId(assetIdSchema.parse(asset))}`
}

export const tradingPairSchema = z
  .object({
    base: assetIdSchema,
    counter: assetIdSchema,
  })
  .strict()
  .superRefine((pair, context) => {
    if (formatAssetId(pair.base) === formatAssetId(pair.counter)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['counter'],
        message: 'trading pair assets must be different',
      })
    }
  })
export type TradingPair = z.infer<typeof tradingPairSchema>

function assetSortKey(asset: AssetId) {
  return asset.kind === 'native' ? '0:native' : `1:${asset.code}:${asset.issuer}`
}

export function canonicalizeTradingPair(pairInput: unknown): TradingPair {
  const pair = tradingPairSchema.parse(pairInput)
  return assetSortKey(pair.base) <= assetSortKey(pair.counter)
    ? pair
    : { base: pair.counter, counter: pair.base }
}

export function formatTradingPairId(pairInput: unknown) {
  const pair = canonicalizeTradingPair(pairInput)
  return `${formatAssetId(pair.base)}~${formatAssetId(pair.counter)}`
}

export function parseTradingPairId(value: unknown): TradingPair {
  if (typeof value !== 'string') return canonicalizeTradingPair(value)
  const parts = value.split('~')
  if (parts.length !== 2) throw new Error('pair must be BASE~COUNTER')
  return canonicalizeTradingPair({ base: parseAssetId(parts[0]), counter: parseAssetId(parts[1]) })
}

export function formatNetworkPairKey(networkId: NetworkIdentity['id'], pair: unknown) {
  return `${networkIdSchema.parse(networkId)}:${formatTradingPairId(pair)}`
}

export const metricIdSchema = z.enum([
  'latest_ledger',
  'circulating_supply',
  'order_book_depth',
  'trustline_count',
  'anchor_reserves',
])
export type MetricId = z.infer<typeof metricIdSchema>

export const sourceClassSchema = z.enum(SOURCE_CLASS_IDS)
export const sourceAdapterSchema = z.enum(['horizon', 'archive', 'sdex', 'anchor', 'oracle'])

export const httpUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'source URL must use HTTP or HTTPS' })
    }
    if (url.username || url.password) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'source URL must not contain credentials' })
    }
  })

export const sourceIdentitySchema = z
  .object({
    id: identifierSchema,
    sourceClass: sourceClassSchema,
    adapter: sourceAdapterSchema,
    url: httpUrlSchema,
    network: networkIdentitySchema,
  })
  .strict()
export type SourceIdentity = z.infer<typeof sourceIdentitySchema>

export const observationProvenanceSchema = z
  .object({
    source: sourceIdentitySchema,
    sourceTimestamp: utcTimestampSchema.nullable(),
    retrievedAt: utcTimestampSchema,
    requestId: identifierSchema.optional(),
  })
  .strict()
export type ObservationProvenance = z.infer<typeof observationProvenanceSchema>

export const stellarAmountSchema = z.union([
  z.custom<StellarAmount>((value) => value instanceof StellarAmount, {
    message: 'value must be a StellarAmount or canonical decimal string',
  }),
  z.string().transform((value, context) => {
    try {
      return parseStellarAmount(value)
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'invalid Stellar amount',
      })
      return z.NEVER
    }
  }),
])

export const nonnegativeCountSchema = z.union([
  z.bigint().nonnegative(),
  z.string().regex(/^(0|[1-9]\d*)$/).transform((value) => BigInt(value)),
])

export const trustlineStateCountsSchema = z.object({
  authorized: nonnegativeCountSchema,
  authorized_to_maintain_liabilities: nonnegativeCountSchema,
  unauthorized: nonnegativeCountSchema,
}).strict()

function formatPositiveRational(numerator: string, denominator: string, decimals = 7) {
  const scale = 10n ** BigInt(decimals)
  const scaled = BigInt(numerator) * scale
  const divisor = BigInt(denominator)
  let rounded = scaled / divisor
  if ((scaled % divisor) * 2n >= divisor) rounded += 1n
  return `${rounded / scale}.${(rounded % scale).toString().padStart(decimals, '0')}`
}

export const supplyComponentsSchema = z.object({
  authorized_trustlines: stellarAmountSchema,
  maintain_liabilities_trustlines: stellarAmountSchema,
  unauthorized_trustlines: stellarAmountSchema,
  claimable_balances: stellarAmountSchema,
  liquidity_pools: stellarAmountSchema,
  contract_balances: stellarAmountSchema,
}).strict()

export const supplyDerivationFamilySchema = z.enum([
  'horizon_asset_aggregate',
  'history_archive_state_replay',
])

const horizonSupplyCheckpointEvidenceSchema = z.object({
  kind: z.literal('horizon_asset_page'),
  ledgerSequence: z.number().int().safe().positive(),
  terminalCursor: z.string().min(1),
  pagesScanned: z.number().int().safe().positive(),
  recordsScanned: z.literal(1),
}).strict()

const archiveSupplyCheckpointEvidenceSchema = z.object({
  kind: z.literal('history_archive_replay'),
  ledgerSequence: z.number().int().safe().positive(),
  ledgerHash: z.string().regex(/^[0-9a-f]{64}$/),
  trustedLedgerHash: z.string().regex(/^[0-9a-f]{64}$/),
  bucketListHash: z.string().regex(/^[0-9a-f]{64}$/),
  historyArchiveStateSha256: z.string().regex(/^[0-9a-f]{64}$/),
  trustedArtifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
  trustProvenance: z.object({
    manifestId: identifierSchema,
    source: z.string().url(),
    verificationMethod: z.enum(['trusted_manifest_signature', 'stellar_core_extra_verification']),
    verificationEvidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    verifiedAt: utcTimestampSchema,
  }).strict(),
  replayStartLedger: z.number().int().safe().positive(),
  replayEndLedger: z.number().int().safe().positive(),
}).strict().superRefine((checkpoint, context) => {
  if (checkpoint.replayStartLedger > checkpoint.replayEndLedger) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['replayStartLedger'],
      message: 'archive replay cannot start after it ends',
    })
  }
  if (checkpoint.replayEndLedger !== checkpoint.ledgerSequence) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['replayEndLedger'],
      message: 'archive replay must end at the observation ledger',
    })
  }
  if (checkpoint.trustedLedgerHash !== checkpoint.ledgerHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['trustedLedgerHash'],
      message: 'trusted checkpoint hash must match the replayed ledger hash',
    })
  }
})

export const supplyDerivationSchema = z.discriminatedUnion('family', [
  z.object({
    family: z.literal('horizon_asset_aggregate'),
    connectorVersion: z.string().min(1).max(100),
    evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    software: z.object({ name: z.literal('stellar-horizon'), version: z.string().min(1).max(100).nullable() }).strict(),
    checkpoint: horizonSupplyCheckpointEvidenceSchema,
  }).strict(),
  z.object({
    family: z.literal('history_archive_state_replay'),
    connectorVersion: z.string().min(1).max(100),
    evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    software: z.object({
      name: z.string().min(1).max(100),
      version: z.string().min(1).max(100),
      stellarCoreVersion: z.string().min(1).max(100),
    }).strict(),
    checkpoint: archiveSupplyCheckpointEvidenceSchema,
  }).strict(),
])

const observationBaseSchema = z.object({
  observationId: identifierSchema,
  cycleId: identifierSchema,
  provenance: observationProvenanceSchema,
})

export const latestLedgerObservationSchema = observationBaseSchema
  .extend({
    metric: z.literal('latest_ledger'),
    ledgerSequence: z.number().int().safe().positive(),
  })
  .strict()

const circulatingSupplyObservationObjectSchema = observationBaseSchema
  .extend({
    metric: z.literal('circulating_supply'),
    asset: creditAssetSchema,
    amount: stellarAmountSchema,
    components: supplyComponentsSchema,
    ledgerSequence: z.number().int().safe().positive(),
    methodologyVersion: z.literal(SUPPLY_METHODOLOGY_VERSION),
    derivation: supplyDerivationSchema,
  })
  .strict()

function validateCirculatingSupplyObservation(
  observation: z.infer<typeof circulatingSupplyObservationObjectSchema>,
  context: z.RefinementCtx,
) {
    if (observation.provenance.sourceTimestamp === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provenance', 'sourceTimestamp'],
        message: 'supply observation requires a closed-ledger source timestamp',
      })
    }
    if (observation.derivation.checkpoint.ledgerSequence !== observation.ledgerSequence) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['derivation', 'checkpoint', 'ledgerSequence'],
        message: 'derivation checkpoint must match the observation ledger',
      })
    }
    const components = Object.values(observation.components) as StellarAmount[]
    const total = components.reduce((sum, component) => sum.add(component), StellarAmount.fromStroops(0n))
    if (!total.equals(observation.amount)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'supply amount must equal the exact component total',
      })
    }
    const source = observation.provenance.source
    if (
      (observation.derivation.family === 'horizon_asset_aggregate' &&
        (source.adapter !== 'horizon' || source.sourceClass !== 'canonical_ledger')) ||
      (observation.derivation.family === 'history_archive_state_replay' &&
        (source.adapter !== 'archive' || source.sourceClass !== 'archive'))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['derivation', 'family'],
        message: 'supply derivation family does not match its source identity',
      })
    }
}

export const circulatingSupplyObservationSchema = circulatingSupplyObservationObjectSchema
  .superRefine(validateCirculatingSupplyObservation)

const orderBookDepthObservationObjectSchema = observationBaseSchema
  .extend({
    metric: z.literal('order_book_depth'),
    pair: tradingPairSchema,
    side: z.enum(['bid', 'ask']),
    priceBandBasisPoints: z.number().int().safe().positive(),
    amount: stellarAmountSchema,
    referencePrice: z.object({
      numerator: z.string().regex(/^[1-9]\d*$/),
      denominator: z.string().regex(/^[1-9]\d*$/),
    }).strict(),
    ledgerSequence: z.number().int().safe().positive(),
    methodologyVersion: z.literal(DEPTH_METHODOLOGY_VERSION),
    derivation: z.object({
      family: z.literal('horizon_sdex_offers'),
      connectorVersion: z.string().min(1).max(100),
      evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
      checkpoint: z.object({
        ledgerSequence: z.number().int().safe().positive(),
        pagesScanned: z.number().int().safe().positive(),
        recordsScanned: z.number().int().safe().nonnegative(),
      }).strict(),
    }).strict(),
  })
  .strict()

function validateOrderBookDepthObservation(
  observation: z.infer<typeof orderBookDepthObservationObjectSchema>,
  context: z.RefinementCtx,
) {
  if (observation.provenance.sourceTimestamp === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['provenance', 'sourceTimestamp'],
      message: 'depth observation requires a closed-ledger source timestamp',
    })
  }
  if (observation.derivation.checkpoint.ledgerSequence !== observation.ledgerSequence) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['derivation', 'checkpoint', 'ledgerSequence'],
      message: 'depth checkpoint must match the observation ledger',
    })
  }
  const source = observation.provenance.source
  if (source.adapter !== 'sdex' || source.sourceClass !== 'dex') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['provenance', 'source'],
      message: 'Horizon SDEX depth requires a dex/sdex source identity',
    })
  }
  if (!(DEPTH_PRICE_BANDS_BPS as readonly number[]).includes(observation.priceBandBasisPoints)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['priceBandBasisPoints'],
      message: `depth price band must be one of ${DEPTH_PRICE_BANDS_BPS.join(', ')} basis points`,
    })
  }
  if (assetSortKey(observation.pair.base) > assetSortKey(observation.pair.counter)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pair'],
      message: 'depth observation pair must use canonical asset order',
    })
  }
}

export const orderBookDepthObservationSchema = orderBookDepthObservationObjectSchema
  .superRefine(validateOrderBookDepthObservation)

const trustlineCountObservationObjectSchema = observationBaseSchema
  .extend({
    metric: z.literal('trustline_count'),
    asset: creditAssetSchema,
    total: nonnegativeCountSchema,
    states: trustlineStateCountsSchema,
    ledgerSequence: z.number().int().safe().positive(),
    methodologyVersion: z.literal(TRUSTLINE_METHODOLOGY_VERSION),
    derivation: z.object({
      family: z.literal('horizon_asset_aggregate'),
      connectorVersion: z.string().min(1).max(100),
      evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
      checkpoint: z.object({ ledgerSequence: z.number().int().safe().positive() }).strict(),
    }).strict(),
  })
  .strict()

function validateTrustlineCountObservation(
  observation: z.infer<typeof trustlineCountObservationObjectSchema>,
  context: z.RefinementCtx,
) {
  if (observation.provenance.sourceTimestamp === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['provenance', 'sourceTimestamp'], message: 'trustline observation requires a closed-ledger timestamp' })
  if (observation.derivation.checkpoint.ledgerSequence !== observation.ledgerSequence) context.addIssue({ code: z.ZodIssueCode.custom, path: ['derivation', 'checkpoint', 'ledgerSequence'], message: 'trustline checkpoint must match the observation ledger' })
  const total = TRUSTLINE_STATE_IDS.reduce((sum, state) => sum + observation.states[state], 0n)
  if (total !== observation.total) context.addIssue({ code: z.ZodIssueCode.custom, path: ['total'], message: 'trustline total must equal its authorization-state counts' })
  const source = observation.provenance.source
  if (source.adapter !== 'horizon' || source.sourceClass !== 'canonical_ledger') context.addIssue({ code: z.ZodIssueCode.custom, path: ['provenance', 'source'], message: 'Horizon trustline aggregates require a canonical-ledger Horizon source' })
}

export const trustlineCountObservationSchema = trustlineCountObservationObjectSchema.superRefine(validateTrustlineCountObservation)

export const anchorReservesObservationSchema = observationBaseSchema
  .extend({
    metric: z.literal('anchor_reserves'),
    anchorId: identifierSchema,
    asset: assetIdSchema,
    amount: stellarAmountSchema,
    attestationPeriodEnd: utcTimestampSchema,
  })
  .strict()

export const rawObservationSchema = z.discriminatedUnion('metric', [
  latestLedgerObservationSchema,
  circulatingSupplyObservationObjectSchema,
  orderBookDepthObservationObjectSchema,
  trustlineCountObservationObjectSchema,
  anchorReservesObservationSchema,
])
  .superRefine((observation, context) => {
    if (observation.metric === 'circulating_supply') validateCirculatingSupplyObservation(observation, context)
    if (observation.metric === 'order_book_depth') validateOrderBookDepthObservation(observation, context)
    if (observation.metric === 'trustline_count') validateTrustlineCountObservation(observation, context)
  })
export type RawObservation = z.infer<typeof rawObservationSchema>

export const sourceErrorCodeSchema = z.enum([
  'invalid_asset',
  'invalid_pair',
  'invalid_configuration',
  'request_failed',
  'request_aborted',
  'non_200_response',
  'redirect_rejected',
  'response_too_large',
  'malformed_payload',
  'empty_records',
  'empty_ledger_records',
  'network_mismatch',
  'issuer_not_found',
  'asset_not_found',
  'partial_scan',
  'ledger_changed',
  'duplicate_record',
  'checkpoint_mismatch',
  'artifact_integrity_mismatch',
  'total_mismatch',
  'stale_observation',
  'stale_book',
  'crossed_book',
  'empty_book',
  'one_sided_book',
  'excluded_source',
])

export const sourceErrorSchema = z
  .object({
    sourceId: identifierSchema.nullable(),
    sourceUrl: httpUrlSchema.nullable(),
    code: sourceErrorCodeSchema,
    category: z.enum(['configuration', 'transport', 'http', 'payload', 'network', 'freshness', 'policy']),
    message: z.string().min(1).max(500),
    occurredAt: utcTimestampSchema,
    httpStatus: z.number().int().min(100).max(599).optional(),
    retryable: z.boolean(),
  })
  .strict()
export type SourceError = z.infer<typeof sourceErrorSchema>

const retrievalAttemptBaseSchema = z.object({
  attemptId: identifierSchema,
  cycleId: identifierSchema,
  source: sourceIdentitySchema,
  startedAt: utcTimestampSchema,
  completedAt: utcTimestampSchema,
})

export const successfulRetrievalAttemptSchema = retrievalAttemptBaseSchema
  .extend({
    outcome: z.literal('success'),
    httpStatus: z.number().int().min(100).max(399).optional(),
    observationIds: z.array(identifierSchema).min(1),
  })
  .strict()

export const failedRetrievalAttemptSchema = retrievalAttemptBaseSchema
  .extend({
    outcome: z.literal('failure'),
    error: sourceErrorSchema,
  })
  .strict()

export const retrievalAttemptSchema = z
  .discriminatedUnion('outcome', [successfulRetrievalAttemptSchema, failedRetrievalAttemptSchema])
  .superRefine((attempt, context) => {
    if (Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completedAt'],
        message: 'retrieval attempt cannot complete before it starts',
      })
    }
  })
export type RetrievalAttempt = z.infer<typeof retrievalAttemptSchema>

const depthPriceBandSchema = z.union([z.literal(50), z.literal(100), z.literal(500)])

const depthBucketValueSchema = z.object({
  side: z.enum(['bid', 'ask']),
  priceBandBasisPoints: depthPriceBandSchema,
  value: stellarAmountSchema,
}).strict()

const depthMetricValueSchema = z.object({
  kind: z.literal('depth'),
  referencePrice: z.object({
    numerator: z.string().regex(/^[1-9]\d*$/),
    denominator: z.string().regex(/^[1-9]\d*$/),
    decimal: z.string().regex(/^(0|[1-9]\d*)\.\d{7}$/),
  }).strict(),
  ledgerSequence: z.number().int().safe().positive(),
  ledgerClosedAt: utcTimestampSchema,
  buckets: z.array(depthBucketValueSchema).length(DEPTH_PRICE_BANDS_BPS.length * 2),
}).strict()

const trustlineStateMetricValueSchema = z.object({
  kind: z.literal('trustline_state'),
  total: nonnegativeCountSchema,
  states: trustlineStateCountsSchema,
  ledgerSequence: z.number().int().safe().positive(),
  ledgerClosedAt: utcTimestampSchema,
}).strict()

export const metricValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ledger'), value: z.number().int().safe().positive() }).strict(),
  z.object({ kind: z.literal('amount'), value: stellarAmountSchema }).strict(),
  depthMetricValueSchema,
  trustlineStateMetricValueSchema,
  z
    .object({
      kind: z.literal('count'),
      value: z.union([
        z.bigint().nonnegative(),
        z.string().regex(/^(0|[1-9]\d*)$/).transform((value) => BigInt(value)),
      ]),
    })
    .strict(),
]).superRefine((value, context) => {
  if (value.kind === 'trustline_state') {
    const total = TRUSTLINE_STATE_IDS.reduce((sum, state) => sum + value.states[state], 0n)
    if (total !== value.total) context.addIssue({ code: z.ZodIssueCode.custom, path: ['total'], message: 'trustline total must equal its authorization-state counts' })
    return
  }
  if (value.kind !== 'depth') return
  if (formatPositiveRational(value.referencePrice.numerator, value.referencePrice.denominator) !== value.referencePrice.decimal) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['referencePrice', 'decimal'], message: 'depth reference decimal must match its exact ratio' })
  }
  const keys = value.buckets.map((bucket) => `${bucket.side}:${bucket.priceBandBasisPoints}`)
  if (new Set(keys).size !== DEPTH_PRICE_BANDS_BPS.length * 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['buckets'], message: 'depth book must contain each side and price band exactly once' })
  }
  for (const side of ['bid', 'ask'] as const) {
    const amounts = DEPTH_PRICE_BANDS_BPS.map((band) =>
      value.buckets.find((bucket) => bucket.side === side && bucket.priceBandBasisPoints === band)?.value,
    )
    amounts.forEach((amount, index) => {
      if (index > 0 && amount && amounts[index - 1] && amount.compare(amounts[index - 1]!) < 0) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['buckets'], message: `${side} depth must be cumulative across wider bands` })
      }
    })
  }
})
export type MetricValue = z.infer<typeof metricValueSchema>

export const metricSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('network'), network: networkIdentitySchema }).strict(),
  z.object({ kind: z.literal('asset'), asset: assetIdSchema }).strict(),
  z.object({ kind: z.literal('pair'), pair: tradingPairSchema }).strict(),
])
export type MetricSubject = z.infer<typeof metricSubjectSchema>

export const confidenceSchema = z
  .object({
    score: z.number().finite().min(0).max(1),
    formulaVersion: z.string().min(1).max(100),
    components: z.record(z.number().finite().min(0).max(1)).refine((value) => Object.keys(value).length > 0, {
      message: 'confidence must include at least one component',
    }),
    capsApplied: z.array(z.string().min(1).max(100)),
  })
  .strict()
export type Confidence = z.infer<typeof confidenceSchema>

export const measurementSeveritySchema = z.enum(['info', 'warning', 'critical'])
export const discrepancyLifecycleStateSchema = z.enum(['open', 'resolved'])
export const discrepancyPublicationStateSchema = z.enum(['internal', 'pending_reply', 'approved_public', 'withheld'])
export const replyReviewStateSchema = z.enum([
  'not_required',
  'awaiting_reply',
  'response_received',
  'response_reviewed',
  'window_expired',
])

export const persistedDiscrepancyStateSchema = z
  .object({
    discrepancyId: identifierSchema,
    sourceId: identifierSchema,
    methodologyVersion: z.string().trim().min(1).max(100),
    namedParty: z.boolean(),
    severity: measurementSeveritySchema,
    lifecycleState: discrepancyLifecycleStateSchema,
    publicationState: discrepancyPublicationStateSchema,
    replyReviewState: replyReviewStateSchema,
    consecutiveCycles: z.number().int().safe().nonnegative(),
    consecutiveAboveInfoCycles: z.number().int().safe().nonnegative(),
    firstObservedAt: utcTimestampSchema,
    lastObservedAt: utcTimestampSchema,
    lastFinalizedCycleAt: utcTimestampSchema,
    lastFinalizedCycleId: identifierSchema,
    publicationUpdatedAt: utcTimestampSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.lastObservedAt < state.firstObservedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['lastObservedAt'], message: 'last observation precedes first observation' })
    }
    if (state.lastFinalizedCycleAt < state.firstObservedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['lastFinalizedCycleAt'], message: 'last finalized cycle precedes first observation' })
    }
    if (state.lastFinalizedCycleAt < state.lastObservedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['lastFinalizedCycleAt'], message: 'last finalized cycle precedes last observation' })
    }
    if (state.publicationUpdatedAt < state.firstObservedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['publicationUpdatedAt'], message: 'publication update precedes first observation' })
    }
    if (state.consecutiveAboveInfoCycles > state.consecutiveCycles) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consecutiveAboveInfoCycles'],
        message: 'above-Info cycles exceed total consecutive cycles',
      })
    }
    if (state.lifecycleState === 'open' && state.consecutiveCycles === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['consecutiveCycles'], message: 'open discrepancy requires persistence' })
    }
    if (
      state.lifecycleState === 'resolved' &&
      (state.consecutiveCycles !== 0 || state.consecutiveAboveInfoCycles !== 0)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['consecutiveCycles'], message: 'resolved discrepancy must reset persistence' })
    }
    if (state.lifecycleState === 'open') {
      const severityMatchesStreak =
        (state.severity === 'info' && state.consecutiveAboveInfoCycles === 0) ||
        (state.severity === 'warning' && [1, 2].includes(state.consecutiveAboveInfoCycles)) ||
        (state.severity === 'critical' && state.consecutiveAboveInfoCycles >= 3)
      if (!severityMatchesStreak) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['severity'],
          message: 'severity does not match the above-Info persistence streak',
        })
      }
    }
    if (state.severity === 'info' && state.publicationState !== 'internal') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['publicationState'], message: 'Info discrepancy must remain internal' })
    }
    if (state.namedParty && state.severity !== 'info' && state.publicationState === 'internal') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publicationState'],
        message: 'named-party Warning or Critical discrepancy requires reply review',
      })
    }
    if (state.publicationState === 'internal' && state.replyReviewState !== 'not_required') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['replyReviewState'], message: 'internal discrepancy cannot have an active reply review' })
    }
    if (state.publicationState === 'pending_reply' && state.replyReviewState === 'not_required') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['replyReviewState'], message: 'pending publication requires reply review state' })
    }
    if (state.publicationState === 'pending_reply' && !state.namedParty) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['namedParty'], message: 'pending reply requires a named party' })
    }
    if (
      state.namedParty &&
      state.publicationState === 'approved_public' &&
      !['response_reviewed', 'window_expired'].includes(state.replyReviewState)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['replyReviewState'],
        message: 'named-party public discrepancy requires completed reply review',
      })
    }
    if (!state.namedParty && state.publicationState === 'approved_public' && state.replyReviewState !== 'not_required') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['replyReviewState'],
        message: 'non-named public discrepancy cannot retain a reply review state',
      })
    }
  })
export type PersistedDiscrepancyState = z.infer<typeof persistedDiscrepancyStateSchema>

export const reconciliationContributionSchema = z
  .object({
    observationId: identifierSchema,
    sourceId: identifierSchema,
    sourceClass: sourceClassSchema,
    ageSeconds: z.number().finite().nonnegative(),
    effectiveWeight: z.number().finite().nonnegative(),
    agrees: z.boolean(),
  })
  .strict()
export type ReconciliationContribution = z.infer<typeof reconciliationContributionSchema>

export const discrepancyDetailsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('supply_comparison'),
    observedLedgerSequence: z.number().int().safe().positive(),
    referenceLedgerSequence: z.number().int().safe().positive(),
    observedSourceTimestamp: utcTimestampSchema,
    referenceSourceTimestamp: utcTimestampSchema,
    componentDifferences: z.array(z.object({
      component: z.enum(SUPPLY_COMPONENT_IDS),
      observed: stellarAmountSchema,
      reference: stellarAmountSchema,
      absoluteDelta: stellarAmountSchema,
    }).strict())
      .max(SUPPLY_COMPONENT_IDS.length)
      .refine(
        (differences) => new Set(differences.map((difference) => difference.component)).size === differences.length,
        { message: 'supply component differences must be unique' },
      ),
  }).strict(),
  z.object({
    kind: z.literal('depth_comparison'),
    observedLedgerSequence: z.number().int().safe().positive(),
    referenceLedgerSequence: z.number().int().safe().positive(),
    observedSourceTimestamp: utcTimestampSchema,
    referenceSourceTimestamp: utcTimestampSchema,
    bucketDifferences: z.array(z.object({
      side: z.enum(['bid', 'ask']),
      priceBandBasisPoints: depthPriceBandSchema,
      observed: stellarAmountSchema,
      reference: stellarAmountSchema,
      absoluteDelta: stellarAmountSchema,
    }).strict()).max(DEPTH_PRICE_BANDS_BPS.length * 2),
  }).strict(),
  z.object({
    kind: z.literal('trustline_comparison'),
    observedLedgerSequence: z.number().int().safe().positive(),
    referenceLedgerSequence: z.number().int().safe().positive(),
    observedSourceTimestamp: utcTimestampSchema,
    referenceSourceTimestamp: utcTimestampSchema,
    stateDifferences: z.array(z.object({
      state: z.enum(TRUSTLINE_STATE_IDS),
      observed: nonnegativeCountSchema,
      reference: nonnegativeCountSchema,
      absoluteDelta: nonnegativeCountSchema,
    }).strict()).max(TRUSTLINE_STATE_IDS.length),
  }).strict(),
])
export type DiscrepancyDetails = z.infer<typeof discrepancyDetailsSchema>

export const discrepancySchema = z
  .object({
    id: identifierSchema,
    sourceId: identifierSchema,
    severity: measurementSeveritySchema,
    lifecycleState: discrepancyLifecycleStateSchema,
    publicationState: discrepancyPublicationStateSchema,
    consecutiveCycles: z.number().int().safe().nonnegative(),
    observedValue: metricValueSchema,
    referenceValue: metricValueSchema,
    details: discrepancyDetailsSchema.optional(),
    firstObservedAt: utcTimestampSchema,
    lastObservedAt: utcTimestampSchema,
  })
  .strict()
  .superRefine((discrepancy, context) => {
    if (discrepancy.observedValue.kind !== discrepancy.referenceValue.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['referenceValue', 'kind'],
        message: 'observed and reference values must have the same kind',
      })
    }
    if (Date.parse(discrepancy.lastObservedAt) < Date.parse(discrepancy.firstObservedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lastObservedAt'],
        message: 'last observation cannot precede first observation',
      })
    }
  })
export type Discrepancy = z.infer<typeof discrepancySchema>

export const reconciliationSnapshotSchema = z
  .object({
    snapshotId: identifierSchema,
    cycleId: identifierSchema,
    metric: metricIdSchema,
    subject: metricSubjectSchema,
    status: z.enum(['verified', 'degraded', 'unavailable']),
    value: metricValueSchema.nullable(),
    confidence: confidenceSchema,
    sourcesConfigured: z.number().int().safe().nonnegative(),
    sourcesResponded: z.number().int().safe().nonnegative(),
    sourcesUsable: z.number().int().safe().nonnegative(),
    sourcesAgreeing: z.number().int().safe().nonnegative(),
    sourcesExcluded: z.number().int().safe().nonnegative(),
    contributions: z.array(reconciliationContributionSchema),
    discrepancies: z.array(discrepancySchema),
    sourceErrors: z.array(sourceErrorSchema),
    asOf: utcTimestampSchema,
    methodologyVersion: z.string().min(1).max(100),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const expectedValueKind = {
      latest_ledger: 'ledger',
      circulating_supply: 'amount',
      order_book_depth: 'depth',
      trustline_count: 'trustline_state',
      anchor_reserves: 'amount',
    }[snapshot.metric]
    const expectedSubjectKind = {
      latest_ledger: 'network',
      circulating_supply: 'asset',
      order_book_depth: 'pair',
      trustline_count: 'asset',
      anchor_reserves: 'asset',
    }[snapshot.metric]
    if (snapshot.status === 'unavailable' && snapshot.value !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'unavailable snapshot must have null value' })
    }
    if (snapshot.status !== 'unavailable' && snapshot.value === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'available snapshot must have a value' })
    }
    if (snapshot.value && snapshot.value.kind !== expectedValueKind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value', 'kind'],
        message: `${snapshot.metric} snapshot requires value kind ${expectedValueKind}`,
      })
    }
    if (snapshot.subject.kind !== expectedSubjectKind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subject', 'kind'],
        message: `${snapshot.metric} snapshot requires subject kind ${expectedSubjectKind}`,
      })
    }
    snapshot.discrepancies.forEach((discrepancy, index) => {
      if (discrepancy.observedValue.kind !== expectedValueKind) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['discrepancies', index, 'observedValue', 'kind'],
          message: `${snapshot.metric} discrepancy requires value kind ${expectedValueKind}`,
        })
      }
    })
    if (snapshot.sourcesResponded > snapshot.sourcesConfigured) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourcesResponded'], message: 'responded sources exceed configured sources' })
    }
    if (snapshot.sourcesUsable > snapshot.sourcesResponded) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourcesUsable'], message: 'usable sources exceed responded sources' })
    }
    if (snapshot.sourcesAgreeing > snapshot.sourcesUsable) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourcesAgreeing'], message: 'agreeing sources exceed usable sources' })
    }
    if (snapshot.sourcesExcluded > snapshot.sourcesConfigured) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourcesExcluded'], message: 'excluded sources exceed configured sources' })
    }
  })
export type ReconciliationSnapshot = z.infer<typeof reconciliationSnapshotSchema>
