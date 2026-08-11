import { z } from 'zod'
import { DEPTH_PRICE_BANDS_BPS, SUPPLY_COMPONENT_IDS, TRUSTLINE_STATE_IDS } from '../../config/methodology'
import {
  type MetricValue,
  type MetricId,
  type MetricSubject,
  type ReconciliationSnapshot,
  formatAssetId,
  httpUrlSchema,
  identifierSchema,
  networkIdSchema,
  parseAssetId,
  sourceClassSchema,
  sourceErrorCodeSchema,
  utcTimestampSchema,
} from './domain'

const apiMetricIdSchema = z.enum([
  'latest_ledger',
  'onchain_asset_supply',
  'order_book_depth',
  'trustline_state',
  'anchor_reserves',
])

const apiAssetIdSchema = z.string().superRefine((value, context) => {
  try {
    const parsed = parseAssetId(value)
    if (formatAssetId(parsed) !== value) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'asset identifier must be canonical' })
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'asset must be native or CODE:ISSUER' })
  }
})

const apiMetricSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('network'), network: networkIdSchema }).strict(),
  z.object({ kind: z.literal('asset'), asset: apiAssetIdSchema }).strict(),
  z.object({ kind: z.literal('pair'), base: apiAssetIdSchema, counter: apiAssetIdSchema }).strict(),
]).superRefine((subject, context) => {
  if (subject.kind === 'pair' && subject.base === subject.counter) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['counter'],
      message: 'trading pair assets must be different',
    })
  }
})

const apiMetricValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ledger'), value: z.number().int().safe().positive() }).strict(),
  z.object({ kind: z.literal('amount'), value: z.string().regex(/^(0|[1-9]\d*)(?:\.\d{1,7})?$/) }).strict(),
  z.object({
    kind: z.literal('depth'),
    reference_price: z.object({
      numerator: z.string().regex(/^[1-9]\d*$/),
      denominator: z.string().regex(/^[1-9]\d*$/),
      decimal: z.string().regex(/^(0|[1-9]\d*)\.\d{7}$/),
    }).strict(),
    ledger_sequence: z.number().int().safe().positive(),
    ledger_closed_at: utcTimestampSchema,
    buckets: z.array(z.object({
      side: z.enum(['bid', 'ask']),
      price_band_basis_points: z.union([z.literal(50), z.literal(100), z.literal(500)]),
      value: z.string().regex(/^(0|[1-9]\d*)(?:\.\d{1,7})?$/),
    }).strict()).length(DEPTH_PRICE_BANDS_BPS.length * 2),
  }).strict(),
  z.object({ kind: z.literal('count'), value: z.string().regex(/^(0|[1-9]\d*)$/) }).strict(),
  z.object({
    kind: z.literal('trustline_state'),
    total: z.string().regex(/^(0|[1-9]\d*)$/),
    states: z.object({
      authorized: z.string().regex(/^(0|[1-9]\d*)$/),
      authorized_to_maintain_liabilities: z.string().regex(/^(0|[1-9]\d*)$/),
      unauthorized: z.string().regex(/^(0|[1-9]\d*)$/),
    }).strict(),
    ledger_sequence: z.number().int().safe().positive(),
    ledger_closed_at: utcTimestampSchema,
  }).strict(),
]).superRefine((value, context) => {
  if (value.kind !== 'trustline_state') return
  const statesTotal = TRUSTLINE_STATE_IDS.reduce((total, state) => total + BigInt(value.states[state]), 0n)
  if (statesTotal !== BigInt(value.total)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['total'],
      message: 'trustline total must equal its authorization-state counts',
    })
  }
})

const apiStellarAmountSchema = z.string().regex(/^(0|[1-9]\d*)(?:\.\d{1,7})?$/)

const apiSourceErrorSchema = z
  .object({
    source_id: identifierSchema.nullable(),
    source_url: httpUrlSchema.nullable(),
    code: sourceErrorCodeSchema,
    category: z.enum(['configuration', 'transport', 'http', 'payload', 'network', 'freshness', 'policy']),
    message: z.string().min(1).max(500),
    occurred_at: utcTimestampSchema,
    http_status: z.number().int().min(100).max(599).optional(),
    retryable: z.boolean(),
  })
  .strict()

const apiContributionSchema = z
  .object({
    observation_id: identifierSchema,
    source_id: identifierSchema,
    source_class: sourceClassSchema,
    age_seconds: z.number().finite().nonnegative(),
    effective_weight: z.number().finite().nonnegative(),
    agrees: z.boolean(),
  })
  .strict()

const apiDiscrepancySchema = z
  .object({
    id: identifierSchema,
    source_id: identifierSchema,
    severity: z.enum(['info', 'warning', 'critical']),
    lifecycle_state: z.enum(['open', 'resolved']),
    publication_state: z.literal('approved_public'),
    consecutive_cycles: z.number().int().nonnegative(),
    observed_value: apiMetricValueSchema,
    reference_value: apiMetricValueSchema,
    details: z.discriminatedUnion('kind', [z.object({
      kind: z.literal('supply_comparison'),
      observed_ledger_sequence: z.number().int().safe().positive(),
      reference_ledger_sequence: z.number().int().safe().positive(),
      observed_source_timestamp: utcTimestampSchema,
      reference_source_timestamp: utcTimestampSchema,
      component_differences: z.array(z.object({
        component: z.enum(SUPPLY_COMPONENT_IDS),
        observed: apiStellarAmountSchema,
        reference: apiStellarAmountSchema,
        absolute_delta: apiStellarAmountSchema,
      }).strict())
        .max(SUPPLY_COMPONENT_IDS.length)
        .refine(
          (differences) => new Set(differences.map((difference) => difference.component)).size === differences.length,
          { message: 'supply component differences must be unique' },
        ),
    }).strict(), z.object({
      kind: z.literal('depth_comparison'),
      observed_ledger_sequence: z.number().int().safe().positive(),
      reference_ledger_sequence: z.number().int().safe().positive(),
      observed_source_timestamp: utcTimestampSchema,
      reference_source_timestamp: utcTimestampSchema,
      bucket_differences: z.array(z.object({
        side: z.enum(['bid', 'ask']),
        price_band_basis_points: z.union([z.literal(50), z.literal(100), z.literal(500)]),
        observed: apiStellarAmountSchema,
        reference: apiStellarAmountSchema,
        absolute_delta: apiStellarAmountSchema,
      }).strict()).max(DEPTH_PRICE_BANDS_BPS.length * 2),
    }).strict(), z.object({
      kind: z.literal('trustline_comparison'),
      observed_ledger_sequence: z.number().int().safe().positive(),
      reference_ledger_sequence: z.number().int().safe().positive(),
      observed_source_timestamp: utcTimestampSchema,
      reference_source_timestamp: utcTimestampSchema,
      state_differences: z.array(z.object({
        state: z.enum(TRUSTLINE_STATE_IDS),
        observed: z.string().regex(/^(0|[1-9]\d*)$/),
        reference: z.string().regex(/^(0|[1-9]\d*)$/),
        absolute_delta: z.string().regex(/^(0|[1-9]\d*)$/),
      }).strict()).max(TRUSTLINE_STATE_IDS.length),
    }).strict()]).optional(),
    first_observed_at: utcTimestampSchema,
    last_observed_at: utcTimestampSchema,
  })
  .strict()
  .superRefine((discrepancy, context) => {
    if (discrepancy.observed_value.kind !== discrepancy.reference_value.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reference_value', 'kind'],
        message: 'observed and reference values must have the same kind',
      })
    }
    if (Date.parse(discrepancy.last_observed_at) < Date.parse(discrepancy.first_observed_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['last_observed_at'],
        message: 'last observation cannot precede first observation',
      })
    }
  })

export const apiReconciliationSnapshotSchema = z
  .object({
    metric: apiMetricIdSchema,
    subject: apiMetricSubjectSchema,
    status: z.enum(['verified', 'degraded', 'unavailable']),
    value: apiMetricValueSchema.nullable(),
    confidence: z.number().finite().min(0).max(1),
    confidence_formula_version: z.string().min(1).max(100),
    confidence_components: z.record(z.number().finite().min(0).max(1)).refine(
      (value) => Object.keys(value).length > 0,
      { message: 'confidence must include at least one component' },
    ),
    confidence_caps_applied: z.array(z.string().min(1).max(100)),
    sources_configured: z.number().int().nonnegative(),
    sources_responded: z.number().int().nonnegative(),
    sources_usable: z.number().int().nonnegative(),
    sources_agreeing: z.number().int().nonnegative(),
    sources_excluded: z.number().int().nonnegative(),
    contributions: z.array(apiContributionSchema),
    discrepancies: z.array(apiDiscrepancySchema),
    source_errors: z.array(apiSourceErrorSchema),
    as_of: utcTimestampSchema,
    methodology_version: z.string().min(1).max(100),
    request_id: identifierSchema,
    api_version: z.literal('v1'),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const expectedValueKind = {
      latest_ledger: 'ledger',
      onchain_asset_supply: 'amount',
      order_book_depth: 'depth',
      trustline_state: 'trustline_state',
      anchor_reserves: 'amount',
    }[snapshot.metric]
    const expectedSubjectKind = {
      latest_ledger: 'network',
      onchain_asset_supply: 'asset',
      order_book_depth: 'pair',
      trustline_state: 'asset',
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
      if (discrepancy.observed_value.kind !== expectedValueKind) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['discrepancies', index, 'observed_value', 'kind'],
          message: `${snapshot.metric} discrepancy requires value kind ${expectedValueKind}`,
        })
      }
    })
    if (snapshot.sources_responded > snapshot.sources_configured) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources_responded'], message: 'responded sources exceed configured sources' })
    }
    if (snapshot.sources_usable > snapshot.sources_responded) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources_usable'], message: 'usable sources exceed responded sources' })
    }
    if (snapshot.sources_agreeing > snapshot.sources_usable) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources_agreeing'], message: 'agreeing sources exceed usable sources' })
    }
    if (snapshot.sources_excluded > snapshot.sources_configured) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources_excluded'], message: 'excluded sources exceed configured sources' })
    }
  })
export type ApiReconciliationSnapshot = z.infer<typeof apiReconciliationSnapshotSchema>

export const apiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1).max(100),
        message: z.string().min(1).max(500),
        details: z.record(z.unknown()).optional(),
      })
      .strict(),
    request_id: identifierSchema,
    as_of: utcTimestampSchema,
    api_version: z.literal('v1'),
  })
  .strict()
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>

function serializeMetricValue(value: MetricValue): z.infer<typeof apiMetricValueSchema> {
  switch (value.kind) {
    case 'ledger':
      return { kind: 'ledger', value: value.value }
    case 'amount':
      return { kind: 'amount', value: value.value.toString() }
    case 'count':
      return { kind: 'count', value: value.value.toString() }
    case 'depth':
      return {
        kind: 'depth',
        reference_price: value.referencePrice,
        ledger_sequence: value.ledgerSequence,
        ledger_closed_at: value.ledgerClosedAt,
        buckets: value.buckets.map((bucket) => ({
          side: bucket.side,
          price_band_basis_points: bucket.priceBandBasisPoints,
          value: bucket.value.toString(),
        })),
      }
    case 'trustline_state':
      return {
        kind: 'trustline_state',
        total: value.total.toString(),
        states: Object.fromEntries(
          TRUSTLINE_STATE_IDS.map((state) => [state, value.states[state].toString()]),
        ) as Record<(typeof TRUSTLINE_STATE_IDS)[number], string>,
        ledger_sequence: value.ledgerSequence,
        ledger_closed_at: value.ledgerClosedAt,
      }
  }
}

function serializeMetricSubject(subject: MetricSubject): z.infer<typeof apiMetricSubjectSchema> {
  switch (subject.kind) {
    case 'network':
      return { kind: 'network', network: subject.network.id }
    case 'asset':
      return { kind: 'asset', asset: formatAssetId(subject.asset) }
    case 'pair':
      return {
        kind: 'pair',
        base: formatAssetId(subject.pair.base),
        counter: formatAssetId(subject.pair.counter),
      }
  }
}

function serializeMetricId(metric: MetricId): z.infer<typeof apiMetricIdSchema> {
  if (metric === 'circulating_supply') return 'onchain_asset_supply'
  if (metric === 'trustline_count') return 'trustline_state'
  return metric
}

/** The only domain camelCase → public snake_case adapter; non-public discrepancies are omitted. */
export function serializePublicReconciliationSnapshot(
  snapshot: ReconciliationSnapshot,
  requestId: string,
): ApiReconciliationSnapshot {
  return apiReconciliationSnapshotSchema.parse({
    metric: serializeMetricId(snapshot.metric),
    subject: serializeMetricSubject(snapshot.subject),
    status: snapshot.status,
    value: snapshot.value ? serializeMetricValue(snapshot.value) : null,
    confidence: snapshot.confidence.score,
    confidence_formula_version: snapshot.confidence.formulaVersion,
    confidence_components: snapshot.confidence.components,
    confidence_caps_applied: snapshot.confidence.capsApplied,
    sources_configured: snapshot.sourcesConfigured,
    sources_responded: snapshot.sourcesResponded,
    sources_usable: snapshot.sourcesUsable,
    sources_agreeing: snapshot.sourcesAgreeing,
    sources_excluded: snapshot.sourcesExcluded,
    contributions: snapshot.contributions.map((contribution) => ({
      observation_id: contribution.observationId,
      source_id: contribution.sourceId,
      source_class: contribution.sourceClass,
      age_seconds: contribution.ageSeconds,
      effective_weight: contribution.effectiveWeight,
      agrees: contribution.agrees,
    })),
    discrepancies: snapshot.discrepancies
      .filter((discrepancy) => discrepancy.publicationState === 'approved_public')
      .map((discrepancy) => ({
        id: discrepancy.id,
        source_id: discrepancy.sourceId,
        severity: discrepancy.severity,
        lifecycle_state: discrepancy.lifecycleState,
        publication_state: discrepancy.publicationState,
        consecutive_cycles: discrepancy.consecutiveCycles,
        observed_value: serializeMetricValue(discrepancy.observedValue),
        reference_value: serializeMetricValue(discrepancy.referenceValue),
        ...(discrepancy.details?.kind === 'supply_comparison' ? {
          details: {
            kind: 'supply_comparison' as const,
            observed_ledger_sequence: discrepancy.details.observedLedgerSequence,
            reference_ledger_sequence: discrepancy.details.referenceLedgerSequence,
            observed_source_timestamp: discrepancy.details.observedSourceTimestamp,
            reference_source_timestamp: discrepancy.details.referenceSourceTimestamp,
            component_differences: discrepancy.details.componentDifferences.map((difference) => ({
              component: difference.component,
              observed: difference.observed.toString(),
              reference: difference.reference.toString(),
              absolute_delta: difference.absoluteDelta.toString(),
            })),
          },
        } : discrepancy.details?.kind === 'depth_comparison' ? {
          details: {
            kind: 'depth_comparison' as const,
            observed_ledger_sequence: discrepancy.details.observedLedgerSequence,
            reference_ledger_sequence: discrepancy.details.referenceLedgerSequence,
            observed_source_timestamp: discrepancy.details.observedSourceTimestamp,
            reference_source_timestamp: discrepancy.details.referenceSourceTimestamp,
            bucket_differences: discrepancy.details.bucketDifferences.map((difference) => ({
              side: difference.side,
              price_band_basis_points: difference.priceBandBasisPoints,
              observed: difference.observed.toString(),
              reference: difference.reference.toString(),
              absolute_delta: difference.absoluteDelta.toString(),
            })),
          },
        } : discrepancy.details?.kind === 'trustline_comparison' ? {
          details: {
            kind: 'trustline_comparison' as const,
            observed_ledger_sequence: discrepancy.details.observedLedgerSequence,
            reference_ledger_sequence: discrepancy.details.referenceLedgerSequence,
            observed_source_timestamp: discrepancy.details.observedSourceTimestamp,
            reference_source_timestamp: discrepancy.details.referenceSourceTimestamp,
            state_differences: discrepancy.details.stateDifferences.map((difference) => ({
              state: difference.state,
              observed: difference.observed.toString(),
              reference: difference.reference.toString(),
              absolute_delta: difference.absoluteDelta.toString(),
            })),
          },
        } : {}),
        first_observed_at: discrepancy.firstObservedAt,
        last_observed_at: discrepancy.lastObservedAt,
      })),
    source_errors: snapshot.sourceErrors.map((error) => ({
      source_id: error.sourceId,
      source_url: error.sourceUrl,
      code: error.code,
      category: error.category,
      message: error.message,
      occurred_at: error.occurredAt,
      retryable: error.retryable,
      ...(error.httpStatus === undefined ? {} : { http_status: error.httpStatus }),
    })),
    as_of: snapshot.asOf,
    methodology_version: snapshot.methodologyVersion,
    request_id: requestId,
    api_version: 'v1',
  })
}

export function createApiErrorResponse({
  code,
  message,
  requestId,
  asOf,
  details,
}: {
  code: string
  message: string
  requestId: string
  asOf: Date
  details?: Record<string, unknown>
}): ApiErrorResponse {
  return apiErrorResponseSchema.parse({
    error: { code, message, ...(details === undefined ? {} : { details }) },
    request_id: requestId,
    as_of: asOf.toISOString(),
    api_version: 'v1',
  })
}
