import { z } from 'zod'
import { DEPTH_PRICE_BANDS_BPS, SUPPLY_COMPONENT_IDS, TRUSTLINE_STATE_IDS } from '../../config/methodology'
import {
  type AssetId,
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

export const apiSnapshotEventSchema = z.object({
  snapshot_id: identifierSchema,
  metric: z.enum(['latest_ledger', 'onchain_asset_supply', 'order_book_depth', 'trustline_state']),
  subject: apiMetricSubjectSchema,
  status: z.enum(['verified', 'degraded', 'unavailable']),
  as_of: utcTimestampSchema,
  methodology_version: z.string().min(1).max(128),
  resource: z.string().regex(/^\/api\/v1\/[A-Za-z0-9._~:%/-]+$/),
}).strict()
export type ApiSnapshotEvent = z.infer<typeof apiSnapshotEventSchema>

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

const apiPublicHttpsUrlSchema = httpUrlSchema.refine((value) => new URL(value).protocol === 'https:', 'public anchor evidence must use HTTPS')

const apiAnchorEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ id: identifierSchema, kind: z.literal('link'), url: apiPublicHttpsUrlSchema }).strict(),
  z.object({
    id: identifierSchema,
    kind: z.literal('upload'),
    content_type: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'text/plain']),
    byte_size: z.number().int().positive().max(5_000_000),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
])

const apiAnchorDisclosureSchema = z.object({
  flag_id: identifierSchema,
  severity: z.enum(['warning', 'critical']),
  lifecycle_state: z.literal('open'),
  publication_state: z.enum(['approved_public', 'withheld']),
  methodology_version: z.string().min(1).max(100),
  approved_at: utcTimestampSchema,
  first_observed_at: utcTimestampSchema,
  last_observed_at: utcTimestampSchema,
  measurement: z.object({
    event_id: identifierSchema,
    measured_at: utcTimestampSchema,
    asset: apiAssetIdSchema,
    reserve_amount: apiStellarAmountSchema,
    onchain_supply: apiStellarAmountSchema,
    absolute_delta: apiStellarAmountSchema,
    delta_basis_points: z.number().finite().nonnegative().max(10_000),
    attestation_period_start: utcTimestampSchema,
    attestation_period_end: utcTimestampSchema,
    published_at: utcTimestampSchema,
    attestation: z.object({
      schema: z.string().min(1).max(100),
      document_url: apiPublicHttpsUrlSchema,
      evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    source: z.object({
      id: identifierSchema,
      url: apiPublicHttpsUrlSchema,
      source_class: z.literal('anchor_self_reported'),
    }).strict(),
    supply_reference: z.object({
      snapshot_id: identifierSchema,
      amount: apiStellarAmountSchema,
      as_of: utcTimestampSchema,
      ledger_sequence: z.number().int().safe().positive(),
      ledger_closed_at: utcTimestampSchema,
      status: z.enum(['verified', 'degraded']),
      confidence: z.number().finite().min(0).max(1),
      methodology_version: z.string().min(1).max(100),
    }).strict(),
    confidence: z.object({
      score: z.number().finite().min(0).max(1),
      formula_version: z.string().min(1).max(100),
      components: z.record(z.number().finite().min(0).max(1)),
      caps_applied: z.array(z.string().min(1).max(100)),
    }).strict(),
  }).strict(),
  response: z.object({
    body: z.string().min(1),
    version: z.number().int().positive(),
    submitted_at: utcTimestampSchema,
    reviewed_at: utcTimestampSchema,
    evidence: z.array(apiAnchorEvidenceSchema),
  }).strict().nullable(),
  disputes: z.array(z.object({
    id: identifierSchema,
    body: z.string().min(1),
    status: z.enum(['resolved', 'rejected']),
    submitted_at: utcTimestampSchema,
    resolved_at: utcTimestampSchema,
    evidence: z.array(apiAnchorEvidenceSchema),
  }).strict()),
  corrections: z.array(z.object({
    id: identifierSchema,
    target_event_id: identifierSchema,
    type: z.enum(['corrected', 'retracted']),
    reason: z.string().min(1),
    corrected_deviation_band: z.enum(['within_tolerance', 'info', 'above_info']).nullable(),
    occurred_at: utcTimestampSchema,
  }).strict()),
}).strict().superRefine((disclosure, context) => {
  if (Date.parse(disclosure.last_observed_at) < Date.parse(disclosure.first_observed_at)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['last_observed_at'], message: 'last observation cannot precede first observation' })
  }
  if (disclosure.publication_state === 'withheld' && !disclosure.corrections.some((item) => item.type === 'retracted')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['corrections'], message: 'withheld disclosure requires a public retraction' })
  }
})

export const apiAnchorReservesResponseSchema = z.object({
  anchor: z.object({
    id: identifierSchema,
    name: z.string().min(1),
    network: networkIdSchema,
    stellar_account: z.string().nullable(),
    status: z.enum(['verified', 'suspended']),
  }).strict(),
  disclosures: z.array(apiAnchorDisclosureSchema),
  page: z.object({ next_cursor: z.string().min(1).max(512).nullable() }).strict(),
  as_of: utcTimestampSchema,
  request_id: identifierSchema,
  api_version: z.literal('v1'),
}).strict()
export type ApiAnchorReservesResponse = z.infer<typeof apiAnchorReservesResponseSchema>

export function serializePublicAnchorReserves(
  model: {
    anchor: { id: string; name: string; networkId: string; stellarAccount: string | null; status: string }
    asOf: string
    nextCursor: string | null
    disclosures: readonly {
      flagId: string
      severity: string
      lifecycleState: string
      publicationState: string
      methodologyVersion: string
      approvedAt: string
      firstObservedAt: string
      lastObservedAt: string
      measurement: {
        eventId: string; measuredAt: string; asset: AssetId; reserveAmount: { toString(): string }; onchainSupply: { toString(): string }
        absoluteDelta: { toString(): string }; deltaBasisPoints: number; attestationPeriodStart: string; attestationPeriodEnd: string
        publishedAt: string; attestation: { schema: string; documentUrl: string; evidenceSha256: string }
        source: { id: string; url: string; sourceClass: string }
        supplyReference: { snapshotId: string; amount: string; asOf: string; ledgerSequence: number; ledgerClosedAt: string; status: string; confidence: number; methodologyVersion: string }
        confidence: { score: number; formulaVersion: string; components: Record<string, number>; capsApplied: string[] }
      }
      response: null | { body: string; version: number; submittedAt: string; reviewedAt: string; evidence: readonly Record<string, unknown>[] }
      disputes: readonly { id: string; body: string; status: string; submittedAt: string; resolvedAt: string | null; evidence: readonly Record<string, unknown>[] }[]
      corrections: readonly { id: string; targetEventId: string; type: string; reason: string; replacement: Record<string, unknown> | null; occurredAt: string }[]
    }[]
  },
  requestId: string,
): ApiAnchorReservesResponse {
  return apiAnchorReservesResponseSchema.parse({
    anchor: {
      id: model.anchor.id,
      name: model.anchor.name,
      network: model.anchor.networkId,
      stellar_account: model.anchor.stellarAccount,
      status: model.anchor.status,
    },
    disclosures: model.disclosures.map((flag) => ({
      flag_id: flag.flagId,
      severity: flag.severity,
      lifecycle_state: flag.lifecycleState,
      publication_state: flag.publicationState,
      methodology_version: flag.methodologyVersion,
      approved_at: flag.approvedAt,
      first_observed_at: flag.firstObservedAt,
      last_observed_at: flag.lastObservedAt,
      measurement: {
        event_id: flag.measurement.eventId,
        measured_at: flag.measurement.measuredAt,
        asset: formatAssetId(flag.measurement.asset),
        reserve_amount: flag.measurement.reserveAmount.toString(),
        onchain_supply: flag.measurement.onchainSupply.toString(),
        absolute_delta: flag.measurement.absoluteDelta.toString(),
        delta_basis_points: flag.measurement.deltaBasisPoints,
        attestation_period_start: flag.measurement.attestationPeriodStart,
        attestation_period_end: flag.measurement.attestationPeriodEnd,
        published_at: flag.measurement.publishedAt,
        attestation: {
          schema: flag.measurement.attestation.schema,
          document_url: flag.measurement.attestation.documentUrl,
          evidence_sha256: flag.measurement.attestation.evidenceSha256,
        },
        source: {
          id: flag.measurement.source.id,
          url: flag.measurement.source.url,
          source_class: flag.measurement.source.sourceClass,
        },
        supply_reference: {
          snapshot_id: flag.measurement.supplyReference.snapshotId,
          amount: flag.measurement.supplyReference.amount,
          as_of: flag.measurement.supplyReference.asOf,
          ledger_sequence: flag.measurement.supplyReference.ledgerSequence,
          ledger_closed_at: flag.measurement.supplyReference.ledgerClosedAt,
          status: flag.measurement.supplyReference.status,
          confidence: flag.measurement.supplyReference.confidence,
          methodology_version: flag.measurement.supplyReference.methodologyVersion,
        },
        confidence: {
          score: flag.measurement.confidence.score,
          formula_version: flag.measurement.confidence.formulaVersion,
          components: flag.measurement.confidence.components,
          caps_applied: flag.measurement.confidence.capsApplied,
        },
      },
      response: flag.response ? {
        body: flag.response.body,
        version: flag.response.version,
        submitted_at: flag.response.submittedAt,
        reviewed_at: flag.response.reviewedAt,
        evidence: flag.response.evidence.map((item) => item.kind === 'link'
          ? { id: item.id, kind: 'link', url: item.url }
          : { id: item.id, kind: 'upload', content_type: item.contentType, byte_size: item.byteSize, sha256: item.sha256 }),
      } : null,
      disputes: flag.disputes.map((item) => ({
        id: item.id,
        body: item.body,
        status: item.status,
        submitted_at: item.submittedAt,
        resolved_at: item.resolvedAt,
        evidence: item.evidence.map((evidence) => evidence.kind === 'link'
          ? { id: evidence.id, kind: 'link', url: evidence.url }
          : { id: evidence.id, kind: 'upload', content_type: evidence.contentType, byte_size: evidence.byteSize, sha256: evidence.sha256 }),
      })),
      corrections: flag.corrections.map((item) => ({
        id: item.id,
        target_event_id: item.targetEventId,
        type: item.type,
        reason: item.reason,
        corrected_deviation_band: typeof item.replacement?.correctedDeviationBand === 'string'
          ? item.replacement.correctedDeviationBand
          : null,
        occurred_at: item.occurredAt,
      })),
    })),
    page: { next_cursor: model.nextCursor },
    as_of: model.asOf,
    request_id: requestId,
    api_version: 'v1',
  })
}

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

/** Creates the durable public-safe payload shared by live and replayed snapshot events. */
export function serializePublicSnapshotEvent(snapshot: ReconciliationSnapshot, cycleSubjectKey: string): ApiSnapshotEvent {
  if (snapshot.metric === 'anchor_reserves') {
    throw new Error('anchor reserve snapshots require publication-state filtering and are not stream events')
  }
  const networkId = snapshot.subject.kind === 'network'
    ? snapshot.subject.network.id
    : cycleSubjectKey.split(':', 1)[0]
  if (networkId !== 'public') throw new Error('only Public Network snapshots may enter the public event stream')
  const metric = serializeMetricId(snapshot.metric)
  const subject = serializeMetricSubject(snapshot.subject)
  const resource = metric === 'latest_ledger'
    ? '/api/v1/stellar/latest-ledger'
    : metric === 'onchain_asset_supply' && snapshot.subject.kind === 'asset'
      ? `/api/v1/supply/${formatAssetId(snapshot.subject.asset)}`
      : metric === 'order_book_depth' && snapshot.subject.kind === 'pair'
        ? `/api/v1/depth/${formatAssetId(snapshot.subject.pair.base)}~${formatAssetId(snapshot.subject.pair.counter)}`
        : metric === 'trustline_state' && snapshot.subject.kind === 'asset'
          ? `/api/v1/trustlines/${formatAssetId(snapshot.subject.asset)}`
          : null
  if (!resource) throw new Error('snapshot metric and subject cannot produce a public stream resource')
  return apiSnapshotEventSchema.parse({
    snapshot_id: snapshot.snapshotId,
    metric,
    subject,
    status: snapshot.status,
    as_of: snapshot.asOf,
    methodology_version: snapshot.methodologyVersion,
    resource,
  })
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
