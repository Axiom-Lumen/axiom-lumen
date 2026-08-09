import { z } from 'zod'
import { SOURCE_CLASS_IDS } from '../../config/methodology'
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

export const circulatingSupplyObservationSchema = observationBaseSchema
  .extend({
    metric: z.literal('circulating_supply'),
    asset: assetIdSchema,
    amount: stellarAmountSchema,
  })
  .strict()

export const orderBookDepthObservationSchema = observationBaseSchema
  .extend({
    metric: z.literal('order_book_depth'),
    pair: tradingPairSchema,
    side: z.enum(['bid', 'ask']),
    priceBandBasisPoints: z.number().int().safe().positive(),
    amount: stellarAmountSchema,
  })
  .strict()

export const trustlineCountObservationSchema = observationBaseSchema
  .extend({
    metric: z.literal('trustline_count'),
    asset: assetIdSchema,
    count: z.union([
      z.bigint().nonnegative(),
      z.string().regex(/^(0|[1-9]\d*)$/).transform((value) => BigInt(value)),
    ]),
  })
  .strict()

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
  circulatingSupplyObservationSchema,
  orderBookDepthObservationSchema,
  trustlineCountObservationSchema,
  anchorReservesObservationSchema,
])
export type RawObservation = z.infer<typeof rawObservationSchema>

export const sourceErrorCodeSchema = z.enum([
  'invalid_configuration',
  'request_failed',
  'request_aborted',
  'non_200_response',
  'malformed_payload',
  'empty_records',
  'empty_ledger_records',
  'network_mismatch',
  'stale_observation',
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

export const metricValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ledger'), value: z.number().int().safe().positive() }).strict(),
  z.object({ kind: z.literal('amount'), value: stellarAmountSchema }).strict(),
  z
    .object({
      kind: z.literal('depth'),
      value: stellarAmountSchema,
      side: z.enum(['bid', 'ask']),
      priceBandBasisPoints: z.number().int().safe().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('count'),
      value: z.union([
        z.bigint().nonnegative(),
        z.string().regex(/^(0|[1-9]\d*)$/).transform((value) => BigInt(value)),
      ]),
    })
    .strict(),
])
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

export const discrepancySchema = z
  .object({
    id: identifierSchema,
    sourceId: identifierSchema,
    severity: z.enum(['info', 'warning', 'critical']),
    lifecycleState: z.enum(['open', 'resolved']),
    publicationState: z.enum(['internal', 'pending_reply', 'approved_public', 'withheld']),
    consecutiveCycles: z.number().int().safe().nonnegative(),
    observedValue: metricValueSchema,
    referenceValue: metricValueSchema,
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
      trustline_count: 'count',
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
