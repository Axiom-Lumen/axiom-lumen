import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

const utcTimestamp = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' })
const createdAt = () => utcTimestamp('created_at').notNull().defaultNow()

export const metricEnum = pgEnum('metric', [
  'latest_ledger',
  'circulating_supply',
  'order_book_depth',
  'trustline_count',
  'anchor_reserves',
])
export const sourceClassEnum = pgEnum('source_class', [
  'canonical_ledger',
  'archive',
  'dex',
  'anchor_self_reported',
  'third_party_oracle',
])
export const sourceAdapterEnum = pgEnum('source_adapter', ['horizon', 'archive', 'sdex', 'anchor', 'oracle'])
export const assetTypeEnum = pgEnum('asset_type', ['native', 'credit'])
export const ingestCycleStatusEnum = pgEnum('ingest_cycle_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'abandoned',
])
export const retrievalOutcomeEnum = pgEnum('retrieval_outcome', ['success', 'failure'])
export const snapshotStatusEnum = pgEnum('snapshot_status', ['verified', 'degraded', 'unavailable'])
export const sourceHealthStateEnum = pgEnum('source_health_state', [
  'healthy',
  'unreachable',
  'rejected',
  'malformed',
  'stale',
  'network_mismatched',
])
export const sourceCircuitStateEnum = pgEnum('source_circuit_state', ['closed', 'open'])
export const discrepancySeverityEnum = pgEnum('discrepancy_severity', ['info', 'warning', 'critical'])
export const discrepancyLifecycleEnum = pgEnum('discrepancy_lifecycle', ['open', 'resolved'])
export const discrepancyPublicationEnum = pgEnum('discrepancy_publication', [
  'internal',
  'pending_reply',
  'approved_public',
  'withheld',
])
export const replyReviewStateEnum = pgEnum('reply_review_state', [
  'not_required',
  'awaiting_reply',
  'response_received',
  'response_reviewed',
  'window_expired',
])
export const anchorStatusEnum = pgEnum('anchor_status', ['candidate', 'verified', 'suspended', 'retired'])
export const anchorCaseStatusEnum = pgEnum('anchor_case_status', [
  'draft',
  'awaiting_reply',
  'under_review',
  'resolved',
  'closed',
])
export const notificationStatusEnum = pgEnum('notification_status', [
  'pending',
  'sent',
  'failed',
  'cancelled',
])
export const apiPrincipalStatusEnum = pgEnum('api_principal_status', ['active', 'suspended', 'revoked'])

export const networks = pgTable(
  'networks',
  {
    id: text('id').primaryKey(),
    passphrase: text('passphrase').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('networks_passphrase_uidx').on(table.passphrase),
    check('networks_id_not_blank', sql`length(btrim(${table.id})) > 0`),
    check('networks_passphrase_not_blank', sql`length(btrim(${table.passphrase})) > 0`),
  ],
)

export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    networkId: text('network_id')
      .notNull()
      .references(() => networks.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    type: assetTypeEnum('type').notNull(),
    code: text('code'),
    issuer: text('issuer'),
    canonicalId: text('canonical_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('assets_network_canonical_uidx').on(table.networkId, table.canonicalId),
    index('assets_issuer_idx').on(table.issuer),
    check(
      'assets_type_fields_check',
      sql`(${table.type} = 'native' AND ${table.code} IS NULL AND ${table.issuer} IS NULL) OR
          (${table.type} = 'credit' AND ${table.code} IS NOT NULL AND ${table.issuer} IS NOT NULL)`,
    ),
  ],
)

export const anchors = pgTable(
  'anchors',
  {
    id: text('id').primaryKey(),
    networkId: text('network_id')
      .notNull()
      .references(() => networks.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    name: text('name').notNull(),
    stellarAccount: text('stellar_account'),
    status: anchorStatusEnum('status').notNull().default('candidate'),
    createdAt: createdAt(),
    updatedAt: utcTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('anchors_network_name_uidx').on(table.networkId, table.name),
    uniqueIndex('anchors_network_account_uidx').on(table.networkId, table.stellarAccount),
    index('anchors_status_idx').on(table.status),
  ],
)

export const sourceDefinitions = pgTable(
  'source_definitions',
  {
    id: text('id').primaryKey(),
    networkId: text('network_id')
      .notNull()
      .references(() => networks.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    anchorId: text('anchor_id').references(() => anchors.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    sourceClass: sourceClassEnum('source_class').notNull(),
    adapter: sourceAdapterEnum('adapter').notNull(),
    url: text('url').notNull(),
    upstreamId: text('upstream_id'),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: utcTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('source_definitions_network_url_uidx').on(table.networkId, table.url),
    index('source_definitions_enabled_class_idx').on(table.enabled, table.sourceClass),
    index('source_definitions_anchor_idx').on(table.anchorId),
    check('source_definitions_url_not_blank', sql`length(btrim(${table.url})) > 0`),
  ],
)

export const sourceCredentialReferences = pgTable(
  'source_credential_references',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sourceDefinitions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    provider: text('provider').notNull(),
    secretReference: text('secret_reference').notNull(),
    createdAt: createdAt(),
    rotatedAt: utcTimestamp('rotated_at'),
  },
  (table) => [
    uniqueIndex('source_credential_refs_source_provider_uidx').on(table.sourceId, table.provider),
    check('source_credential_refs_secret_not_blank', sql`length(btrim(${table.secretReference})) > 0`),
  ],
)

export const ingestCycles = pgTable(
  'ingest_cycles',
  {
    id: text('id').primaryKey(),
    metric: metricEnum('metric').notNull(),
    subjectKey: text('subject_key').notNull(),
    methodologyVersion: text('methodology_version').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: ingestCycleStatusEnum('status').notNull().default('pending'),
    scheduledAt: utcTimestamp('scheduled_at').notNull(),
    startedAt: utcTimestamp('started_at'),
    completedAt: utcTimestamp('completed_at'),
    failure: jsonb('failure').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('ingest_cycles_idempotency_uidx').on(table.idempotencyKey),
    index('ingest_cycles_metric_subject_completed_idx').on(table.metric, table.subjectKey, table.completedAt),
    index('ingest_cycles_status_scheduled_idx').on(table.status, table.scheduledAt),
    check(
      'ingest_cycles_time_order_check',
      sql`(${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.scheduledAt}) AND
          (${table.completedAt} IS NULL OR (${table.startedAt} IS NOT NULL AND ${table.completedAt} >= ${table.startedAt}))`,
    ),
    check(
      'ingest_cycles_terminal_state_check',
      sql`(${table.status} IN ('completed', 'failed', 'abandoned') AND ${table.completedAt} IS NOT NULL) OR
          (${table.status} IN ('pending', 'running') AND ${table.completedAt} IS NULL)`,
    ),
  ],
)

export const scheduledCycleLeases = pgTable(
  'scheduled_cycle_leases',
  {
    id: text('id').primaryKey(),
    metric: metricEnum('metric').notNull(),
    subjectKey: text('subject_key').notNull(),
    methodologyVersion: text('methodology_version').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    scheduledAt: utcTimestamp('scheduled_at').notNull(),
    status: ingestCycleStatusEnum('status').notNull().default('pending'),
    leaseOwner: text('lease_owner'),
    leaseToken: integer('lease_token').notNull().default(0),
    leaseExpiresAt: utcTimestamp('lease_expires_at'),
    heartbeatAt: utcTimestamp('heartbeat_at'),
    attemptCount: integer('attempt_count').notNull().default(0),
    finalizedCycleId: text('finalized_cycle_id').references(() => ingestCycles.id, {
      onDelete: 'restrict',
      onUpdate: 'cascade',
    }),
    lastError: jsonb('last_error').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: utcTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('scheduled_cycle_leases_idempotency_uidx').on(table.idempotencyKey),
    uniqueIndex('scheduled_cycle_leases_finalized_cycle_uidx').on(table.finalizedCycleId),
    uniqueIndex('scheduled_cycle_leases_active_subject_uidx')
      .on(table.metric, table.subjectKey)
      .where(sql`${table.status} IN ('pending', 'running')`),
    index('scheduled_cycle_leases_pending_idx').on(table.status, table.scheduledAt),
    index('scheduled_cycle_leases_expiry_idx').on(table.status, table.leaseExpiresAt),
    check(
      'scheduled_cycle_leases_counts_check',
      sql`${table.leaseToken} >= 0 AND ${table.attemptCount} >= 0`,
    ),
    check(
      'scheduled_cycle_leases_ownership_check',
      sql`(${table.status} = 'running' AND ${table.leaseOwner} IS NOT NULL AND
            ${table.leaseExpiresAt} IS NOT NULL AND ${table.heartbeatAt} IS NOT NULL) OR
          (${table.status} <> 'running' AND ${table.leaseOwner} IS NULL AND
            ${table.leaseExpiresAt} IS NULL AND ${table.heartbeatAt} IS NULL)`,
    ),
    check(
      'scheduled_cycle_leases_finalization_check',
      sql`(${table.status} = 'completed' AND ${table.finalizedCycleId} IS NOT NULL) OR
          (${table.status} <> 'completed' AND ${table.finalizedCycleId} IS NULL)`,
    ),
  ],
)

export const retrievalAttempts = pgTable(
  'retrieval_attempts',
  {
    id: text('id').primaryKey(),
    cycleId: text('cycle_id')
      .notNull()
      .references(() => ingestCycles.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sourceDefinitions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    outcome: retrievalOutcomeEnum('outcome').notNull(),
    startedAt: utcTimestamp('started_at').notNull(),
    completedAt: utcTimestamp('completed_at').notNull(),
    httpStatus: integer('http_status'),
    error: jsonb('error').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('retrieval_attempts_cycle_source_number_uidx').on(
      table.cycleId,
      table.sourceId,
      table.attemptNumber,
    ),
    unique('retrieval_attempts_identity_context_unique').on(table.id, table.cycleId, table.sourceId),
    index('retrieval_attempts_source_completed_idx').on(table.sourceId, table.completedAt),
    check('retrieval_attempts_number_check', sql`${table.attemptNumber} > 0`),
    check('retrieval_attempts_time_order_check', sql`${table.completedAt} >= ${table.startedAt}`),
    check(
      'retrieval_attempts_outcome_error_check',
      sql`(${table.outcome} = 'success' AND ${table.error} IS NULL) OR
          (${table.outcome} = 'failure' AND ${table.error} IS NOT NULL)`,
    ),
    check(
      'retrieval_attempts_http_status_check',
      sql`${table.httpStatus} IS NULL OR ${table.httpStatus} BETWEEN 100 AND 599`,
    ),
  ],
)

export const rawReadings = pgTable(
  'raw_readings',
  {
    id: text('id').primaryKey(),
    observationId: text('observation_id').notNull(),
    cycleId: text('cycle_id')
      .notNull()
      .references(() => ingestCycles.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => retrievalAttempts.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sourceDefinitions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    metric: metricEnum('metric').notNull(),
    subjectKey: text('subject_key').notNull(),
    sourceIdentity: jsonb('source_identity').$type<Record<string, unknown>>().notNull(),
    normalizedValue: jsonb('normalized_value').$type<Record<string, unknown>>().notNull(),
    rawPayload: jsonb('raw_payload').$type<unknown>().notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    sourceTimestamp: utcTimestamp('source_timestamp'),
    retrievedAt: utcTimestamp('retrieved_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('raw_readings_observation_uidx').on(table.observationId),
    uniqueIndex('raw_readings_cycle_source_uidx').on(table.cycleId, table.sourceId),
    unique('raw_readings_identity_source_unique').on(table.id, table.sourceId),
    index('raw_readings_metric_subject_retrieved_idx').on(table.metric, table.subjectKey, table.retrievedAt),
    index('raw_readings_attempt_idx').on(table.attemptId),
    foreignKey({
      columns: [table.attemptId, table.cycleId, table.sourceId],
      foreignColumns: [retrievalAttempts.id, retrievalAttempts.cycleId, retrievalAttempts.sourceId],
      name: 'raw_readings_attempt_context_fk',
    }).onDelete('restrict').onUpdate('cascade'),
    check('raw_readings_payload_sha256_check', sql`${table.payloadSha256} ~ '^[0-9a-f]{64}$'`),
  ],
)

export const sourceHealthSamples = pgTable(
  'source_health_samples',
  {
    id: text('id').primaryKey(),
    cycleId: text('cycle_id')
      .notNull()
      .references(() => ingestCycles.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sourceDefinitions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    state: sourceHealthStateEnum('state').notNull(),
    latencyMs: integer('latency_ms'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    observedAt: utcTimestamp('observed_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('source_health_samples_cycle_source_uidx').on(table.cycleId, table.sourceId),
    index('source_health_samples_source_observed_idx').on(table.sourceId, table.observedAt),
    check('source_health_samples_latency_check', sql`${table.latencyMs} IS NULL OR ${table.latencyMs} >= 0`),
  ],
)

export const sourceHealthStates = pgTable(
  'source_health_states',
  {
    sourceId: text('source_id')
      .primaryKey()
      .references(() => sourceDefinitions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    state: sourceHealthStateEnum('state').notNull(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    circuitState: sourceCircuitStateEnum('circuit_state').notNull().default('closed'),
    circuitOpenedAt: utcTimestamp('circuit_opened_at'),
    nextAttemptAt: utcTimestamp('next_attempt_at'),
    lastErrorCode: text('last_error_code'),
    lastObservedAt: utcTimestamp('last_observed_at').notNull(),
    updatedAt: utcTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('source_health_states_state_idx').on(table.state, table.lastObservedAt),
    index('source_health_states_circuit_idx').on(table.circuitState, table.nextAttemptAt),
    check('source_health_states_failures_check', sql`${table.consecutiveFailures} >= 0`),
    check(
      'source_health_states_circuit_check',
      sql`(${table.circuitState} = 'closed' AND ${table.circuitOpenedAt} IS NULL) OR
          (${table.circuitState} = 'open' AND ${table.circuitOpenedAt} IS NOT NULL AND ${table.nextAttemptAt} IS NOT NULL)`,
    ),
    check(
      'source_health_states_healthy_check',
      sql`${table.state} <> 'healthy' OR
          (${table.consecutiveFailures} = 0 AND ${table.circuitState} = 'closed' AND
           ${table.nextAttemptAt} IS NULL AND ${table.lastErrorCode} IS NULL)`,
    ),
  ],
)

export const reconciliationSnapshots = pgTable(
  'reconciliation_snapshots',
  {
    id: text('id').primaryKey(),
    cycleId: text('cycle_id')
      .notNull()
      .references(() => ingestCycles.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    metric: metricEnum('metric').notNull(),
    subjectKey: text('subject_key').notNull(),
    status: snapshotStatusEnum('status').notNull(),
    subject: jsonb('subject').$type<Record<string, unknown>>().notNull(),
    value: jsonb('value').$type<Record<string, unknown>>(),
    confidence: numeric('confidence', { precision: 10, scale: 9 }).notNull(),
    confidenceFormulaVersion: text('confidence_formula_version').notNull(),
    confidenceComponents: jsonb('confidence_components').$type<Record<string, number>>().notNull(),
    confidenceCapsApplied: jsonb('confidence_caps_applied').$type<string[]>().notNull().default([]),
    sourceErrors: jsonb('source_errors').$type<Record<string, unknown>[]>().notNull().default([]),
    sourcesConfigured: integer('sources_configured').notNull(),
    sourcesResponded: integer('sources_responded').notNull(),
    sourcesUsable: integer('sources_usable').notNull(),
    sourcesAgreeing: integer('sources_agreeing').notNull(),
    sourcesExcluded: integer('sources_excluded').notNull(),
    methodologyVersion: text('methodology_version').notNull(),
    asOf: utcTimestamp('as_of').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('reconciliation_snapshots_cycle_uidx').on(table.cycleId),
    index('reconciliation_snapshots_latest_idx').on(table.metric, table.subjectKey, table.asOf),
    check('reconciliation_snapshots_confidence_check', sql`${table.confidence} BETWEEN 0 AND 1`),
    check(
      'reconciliation_snapshots_value_check',
      sql`(${table.status} = 'unavailable' AND ${table.value} IS NULL) OR
          (${table.status} <> 'unavailable' AND ${table.value} IS NOT NULL)`,
    ),
    check(
      'reconciliation_snapshots_counts_check',
      sql`${table.sourcesConfigured} >= 0 AND ${table.sourcesResponded} BETWEEN 0 AND ${table.sourcesConfigured} AND
          ${table.sourcesUsable} BETWEEN 0 AND ${table.sourcesResponded} AND
          ${table.sourcesAgreeing} BETWEEN 0 AND ${table.sourcesUsable} AND
          ${table.sourcesExcluded} BETWEEN 0 AND ${table.sourcesConfigured}`,
    ),
  ],
)

export const snapshotContributions = pgTable(
  'snapshot_contributions',
  {
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => reconciliationSnapshots.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    readingId: text('reading_id')
      .notNull()
      .references(() => rawReadings.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sourceDefinitions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    ageSeconds: numeric('age_seconds', { precision: 20, scale: 6 }).notNull(),
    effectiveWeight: numeric('effective_weight', { precision: 20, scale: 12 }).notNull(),
    agrees: boolean('agrees').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.readingId], name: 'snapshot_contributions_pk' }),
    uniqueIndex('snapshot_contributions_snapshot_source_uidx').on(table.snapshotId, table.sourceId),
    index('snapshot_contributions_source_idx').on(table.sourceId),
    foreignKey({
      columns: [table.readingId, table.sourceId],
      foreignColumns: [rawReadings.id, rawReadings.sourceId],
      name: 'snapshot_contributions_reading_source_fk',
    }).onDelete('restrict').onUpdate('cascade'),
    check('snapshot_contributions_age_check', sql`${table.ageSeconds} >= 0`),
    check('snapshot_contributions_weight_check', sql`${table.effectiveWeight} >= 0`),
  ],
)

export const discrepancies = pgTable(
  'discrepancies',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sourceDefinitions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    metric: metricEnum('metric').notNull(),
    subjectKey: text('subject_key').notNull(),
    methodologyVersion: text('methodology_version').notNull(),
    namedParty: boolean('named_party').notNull().default(false),
    severity: discrepancySeverityEnum('severity').notNull(),
    lifecycleState: discrepancyLifecycleEnum('lifecycle_state').notNull(),
    publicationState: discrepancyPublicationEnum('publication_state').notNull(),
    replyReviewState: replyReviewStateEnum('reply_review_state').notNull(),
    consecutiveCycles: integer('consecutive_cycles').notNull(),
    consecutiveAboveInfoCycles: integer('consecutive_above_info_cycles').notNull(),
    firstObservedAt: utcTimestamp('first_observed_at').notNull(),
    lastObservedAt: utcTimestamp('last_observed_at').notNull(),
    lastFinalizedCycleId: text('last_finalized_cycle_id')
      .notNull()
      .references(() => ingestCycles.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    lastFinalizedCycleAt: utcTimestamp('last_finalized_cycle_at').notNull(),
    publicationUpdatedAt: utcTimestamp('publication_updated_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('discrepancies_open_source_subject_uidx')
      .on(table.sourceId, table.metric, table.subjectKey)
      .where(sql`${table.lifecycleState} = 'open'`),
    index('discrepancies_subject_state_idx').on(table.metric, table.subjectKey, table.lifecycleState),
    index('discrepancies_publication_idx').on(table.publicationState, table.publicationUpdatedAt),
    check(
      'discrepancies_streaks_check',
      sql`${table.consecutiveCycles} >= 0 AND ${table.consecutiveAboveInfoCycles} BETWEEN 0 AND ${table.consecutiveCycles}`,
    ),
    check(
      'discrepancies_lifecycle_streak_check',
      sql`(${table.lifecycleState} = 'open' AND ${table.consecutiveCycles} > 0) OR
          (${table.lifecycleState} = 'resolved' AND ${table.consecutiveCycles} = 0 AND ${table.consecutiveAboveInfoCycles} = 0)`,
    ),
    check(
      'discrepancies_time_order_check',
      sql`${table.lastObservedAt} >= ${table.firstObservedAt} AND
          ${table.lastFinalizedCycleAt} >= ${table.lastObservedAt} AND
          ${table.publicationUpdatedAt} >= ${table.firstObservedAt}`,
    ),
    check(
      'discrepancies_publication_check',
      sql`(${table.severity} <> 'info' OR ${table.publicationState} = 'internal') AND
          NOT (${table.namedParty} AND ${table.severity} <> 'info' AND ${table.publicationState} = 'internal') AND
          (${table.publicationState} <> 'pending_reply' OR
            (${table.namedParty} AND ${table.replyReviewState} <> 'not_required'))`,
    ),
  ],
)

export const discrepancyEvents = pgTable(
  'discrepancy_events',
  {
    id: text('id').primaryKey(),
    discrepancyId: text('discrepancy_id')
      .notNull()
      .references(() => discrepancies.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    cycleId: text('cycle_id').references(() => ingestCycles.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    targetEventId: text('target_event_id'),
    eventType: text('event_type').notNull(),
    methodologyVersion: text('methodology_version').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: utcTimestamp('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('discrepancy_events_discrepancy_occurred_idx').on(table.discrepancyId, table.occurredAt),
    index('discrepancy_events_cycle_idx').on(table.cycleId),
    unique('discrepancy_events_identity_context_unique').on(table.id, table.discrepancyId),
    uniqueIndex('discrepancy_events_target_type_uidx').on(table.targetEventId, table.eventType),
    foreignKey({
      columns: [table.targetEventId, table.discrepancyId],
      foreignColumns: [table.id, table.discrepancyId],
      name: 'discrepancy_events_target_event_fk',
    }).onDelete('restrict').onUpdate('cascade'),
    check('discrepancy_events_type_not_blank', sql`length(btrim(${table.eventType})) > 0`),
    check('discrepancy_events_target_not_self', sql`${table.targetEventId} IS NULL OR ${table.targetEventId} <> ${table.id}`),
    check(
      'discrepancy_events_target_required_check',
      sql`(${table.eventType} IN ('resolved', 'corrected', 'retracted') AND ${table.targetEventId} IS NOT NULL) OR
          (${table.eventType} NOT IN ('resolved', 'corrected', 'retracted') AND ${table.targetEventId} IS NULL)`,
    ),
  ],
)

export const anchorDomains = pgTable(
  'anchor_domains',
  {
    id: text('id').primaryKey(),
    anchorId: text('anchor_id')
      .notNull()
      .references(() => anchors.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    domain: text('domain').notNull(),
    verifiedAt: utcTimestamp('verified_at'),
    verificationEvidence: jsonb('verification_evidence').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('anchor_domains_domain_uidx').on(table.domain),
    index('anchor_domains_anchor_idx').on(table.anchorId),
  ],
)

export const anchorContactEndpoints = pgTable(
  'anchor_contact_endpoints',
  {
    id: text('id').primaryKey(),
    anchorId: text('anchor_id')
      .notNull()
      .references(() => anchors.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    kind: text('kind').notNull(),
    endpoint: text('endpoint').notNull(),
    verifiedAt: utcTimestamp('verified_at'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('anchor_contact_endpoints_anchor_kind_endpoint_uidx').on(
      table.anchorId,
      table.kind,
      table.endpoint,
    ),
    check('anchor_contact_endpoints_kind_not_blank', sql`length(btrim(${table.kind})) > 0`),
    check('anchor_contact_endpoints_endpoint_not_blank', sql`length(btrim(${table.endpoint})) > 0`),
  ],
)

export const apiPlans = pgTable(
  'api_plans',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    requestsPerWindow: integer('requests_per_window').notNull(),
    windowSeconds: integer('window_seconds').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: utcTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('api_plans_name_uidx').on(table.name),
    check('api_plans_quota_check', sql`${table.requestsPerWindow} > 0 AND ${table.windowSeconds} > 0`),
  ],
)

export const apiPrincipals = pgTable(
  'api_principals',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => apiPlans.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    displayName: text('display_name').notNull(),
    status: apiPrincipalStatusEnum('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: utcTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [index('api_principals_plan_status_idx').on(table.planId, table.status)],
)

export const apiScopes = pgTable('api_scopes', {
  id: text('id').primaryKey(),
  description: text('description').notNull(),
  createdAt: createdAt(),
})

export const apiPrincipalScopes = pgTable(
  'api_principal_scopes',
  {
    principalId: text('principal_id')
      .notNull()
      .references(() => apiPrincipals.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    scopeId: text('scope_id')
      .notNull()
      .references(() => apiScopes.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    grantedAt: utcTimestamp('granted_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.principalId, table.scopeId], name: 'api_principal_scopes_pk' })],
)

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    principalId: text('principal_id')
      .notNull()
      .references(() => apiPrincipals.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    createdAt: createdAt(),
    expiresAt: utcTimestamp('expires_at'),
    revokedAt: utcTimestamp('revoked_at'),
    lastUsedAt: utcTimestamp('last_used_at'),
  },
  (table) => [
    uniqueIndex('api_keys_prefix_uidx').on(table.keyPrefix),
    uniqueIndex('api_keys_hash_uidx').on(table.keyHash),
    index('api_keys_principal_idx').on(table.principalId),
    check('api_keys_hash_not_blank', sql`length(btrim(${table.keyHash})) > 0`),
    check('api_keys_expiry_check', sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`),
  ],
)

export const apiQuotaUsage = pgTable(
  'api_quota_usage',
  {
    principalId: text('principal_id')
      .notNull()
      .references(() => apiPrincipals.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    windowStartedAt: utcTimestamp('window_started_at').notNull(),
    requestCount: bigint('request_count', { mode: 'bigint' }).notNull().default(sql`0`),
    updatedAt: utcTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.principalId, table.windowStartedAt], name: 'api_quota_usage_pk' }),
    index('api_quota_usage_window_idx').on(table.windowStartedAt),
    check('api_quota_usage_count_check', sql`${table.requestCount} >= 0`),
  ],
)

export const anchorCases = pgTable(
  'anchor_cases',
  {
    id: text('id').primaryKey(),
    anchorId: text('anchor_id')
      .notNull()
      .references(() => anchors.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    discrepancyId: text('discrepancy_id').references(() => discrepancies.id, {
      onDelete: 'restrict',
      onUpdate: 'cascade',
    }),
    status: anchorCaseStatusEnum('status').notNull().default('draft'),
    openedAt: utcTimestamp('opened_at').notNull(),
    replyDueAt: utcTimestamp('reply_due_at'),
    closedAt: utcTimestamp('closed_at'),
    createdAt: createdAt(),
    updatedAt: utcTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('anchor_cases_discrepancy_uidx').on(table.discrepancyId),
    index('anchor_cases_anchor_status_idx').on(table.anchorId, table.status),
    check('anchor_cases_reply_due_check', sql`${table.replyDueAt} IS NULL OR ${table.replyDueAt} >= ${table.openedAt}`),
    check('anchor_cases_closed_check', sql`${table.closedAt} IS NULL OR ${table.closedAt} >= ${table.openedAt}`),
  ],
)

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => anchorCases.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    contactEndpointId: text('contact_endpoint_id')
      .notNull()
      .references(() => anchorContactEndpoints.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    status: notificationStatusEnum('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: utcTimestamp('next_attempt_at'),
    sentAt: utcTimestamp('sent_at'),
    failure: jsonb('failure').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('notifications_idempotency_uidx').on(table.idempotencyKey),
    index('notifications_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
    index('notifications_case_idx').on(table.caseId),
    check('notifications_attempt_count_check', sql`${table.attemptCount} >= 0`),
  ],
)

export const anchorReplies = pgTable(
  'anchor_replies',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => anchorCases.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    submittedBy: text('submitted_by').notNull(),
    body: text('body').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    submittedAt: utcTimestamp('submitted_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('anchor_replies_case_submitted_idx').on(table.caseId, table.submittedAt),
    check('anchor_replies_body_not_blank', sql`length(btrim(${table.body})) > 0`),
  ],
)

export const anchorReviews = pgTable(
  'anchor_reviews',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => anchorCases.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    replyId: text('reply_id').references(() => anchorReplies.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    reviewerPrincipalId: text('reviewer_principal_id')
      .notNull()
      .references(() => apiPrincipals.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    decision: text('decision').notNull(),
    notes: text('notes'),
    reviewedAt: utcTimestamp('reviewed_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('anchor_reviews_case_reviewed_idx').on(table.caseId, table.reviewedAt),
    check('anchor_reviews_decision_not_blank', sql`length(btrim(${table.decision})) > 0`),
  ],
)

export const corrections = pgTable(
  'corrections',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => anchorCases.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    targetEventId: text('target_event_id')
      .notNull()
      .references(() => discrepancyEvents.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    authorPrincipalId: text('author_principal_id')
      .notNull()
      .references(() => apiPrincipals.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    reason: text('reason').notNull(),
    replacement: jsonb('replacement').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    index('corrections_target_event_idx').on(table.targetEventId),
    index('corrections_case_idx').on(table.caseId),
    check('corrections_reason_not_blank', sql`length(btrim(${table.reason})) > 0`),
  ],
)
