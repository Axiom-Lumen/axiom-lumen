import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
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
export const notificationDeliveryOutcomeEnum = pgEnum('notification_delivery_outcome', ['sent', 'failed'])
export const apiPrincipalStatusEnum = pgEnum('api_principal_status', ['active', 'suspended', 'revoked'])
export const apiKeyEventTypeEnum = pgEnum('api_key_event_type', ['created', 'rotated', 'revoked'])
export const apiQuotaKindEnum = pgEnum('api_quota_kind', ['sustained', 'burst'])

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
    index('anchors_network_name_idx').on(table.networkId, table.name),
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
    jobDefinition: jsonb('job_definition').$type<Record<string, unknown>>(),
    jobDefinitionSha256: text('job_definition_sha256'),
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
      'scheduled_cycle_leases_job_definition_check',
      sql`(${table.jobDefinition} IS NULL AND ${table.jobDefinitionSha256} IS NULL) OR
          (${table.jobDefinition} IS NOT NULL AND ${table.jobDefinitionSha256} ~ '^[0-9a-f]{64}$')`,
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

export const snapshotEvents = pgTable(
  'snapshot_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => reconciliationSnapshots.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: utcTimestamp('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('snapshot_events_snapshot_uidx').on(table.snapshotId),
    index('snapshot_events_occurred_idx').on(table.occurredAt, table.id),
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
    verificationExpiresAt: utcTimestamp('verification_expires_at'),
    verificationEvidence: jsonb('verification_evidence').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('anchor_domains_anchor_domain_uidx').on(table.anchorId, table.domain),
    index('anchor_domains_anchor_idx').on(table.anchorId),
  ],
)

export const anchorVerificationEvents = pgTable(
  'anchor_verification_events',
  {
    id: text('id').primaryKey(),
    anchorId: text('anchor_id')
      .notNull()
      .references(() => anchors.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    domainId: text('domain_id')
      .notNull()
      .references(() => anchorDomains.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    eventType: text('event_type').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
    occurredAt: utcTimestamp('occurred_at').notNull(),
    expiresAt: utcTimestamp('expires_at'),
    createdAt: createdAt(),
  },
  (table) => [
    index('anchor_verification_events_anchor_occurred_idx').on(table.anchorId, table.occurredAt),
    index('anchor_verification_events_domain_occurred_idx').on(table.domainId, table.occurredAt),
    check('anchor_verification_events_type_check', sql`${table.eventType} IN ('verified', 'suspended')`),
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
    claimantId: text('claimant_id').references(() => anchorClaimants.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    domainId: text('domain_id').references(() => anchorDomains.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    verificationExpiresAt: utcTimestamp('verification_expires_at'),
    revokedAt: utcTimestamp('revoked_at'),
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
    check('anchor_contact_endpoints_verification_expiry_check', sql`${table.verificationExpiresAt} IS NULL OR (${table.verifiedAt} IS NOT NULL AND ${table.verificationExpiresAt} > ${table.verifiedAt})`),
    check('anchor_contact_endpoints_revoked_check', sql`${table.revokedAt} IS NULL OR (${table.verifiedAt} IS NOT NULL AND ${table.revokedAt} >= ${table.verifiedAt})`),
  ],
)

export const anchorContactSecrets = pgTable(
  'anchor_contact_secrets',
  {
    id: text('id').primaryKey(),
    contactEndpointId: text('contact_endpoint_id')
      .notNull()
      .references(() => anchorContactEndpoints.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    version: integer('version').notNull(),
    keyId: text('key_id').notNull(),
    ciphertext: text('ciphertext').notNull(),
    initializationVector: text('initialization_vector').notNull(),
    authenticationTag: text('authentication_tag').notNull(),
    createdAt: createdAt(),
    retiredAt: utcTimestamp('retired_at'),
  },
  (table) => [
    uniqueIndex('anchor_contact_secrets_version_uidx').on(table.contactEndpointId, table.version),
    uniqueIndex('anchor_contact_secrets_active_uidx').on(table.contactEndpointId).where(sql`${table.retiredAt} IS NULL`),
    index('anchor_contact_secrets_key_idx').on(table.keyId),
    check('anchor_contact_secrets_version_check', sql`${table.version} > 0`),
    check('anchor_contact_secrets_key_not_blank', sql`length(btrim(${table.keyId})) > 0`),
    check('anchor_contact_secrets_ciphertext_not_blank', sql`length(btrim(${table.ciphertext})) > 0`),
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

export const apiPlanRouteLimits = pgTable(
  'api_plan_route_limits',
  {
    planId: text('plan_id')
      .notNull()
      .references(() => apiPlans.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    routeId: text('route_id').notNull(),
    requestsPerWindow: integer('requests_per_window').notNull(),
    windowSeconds: integer('window_seconds').notNull(),
    burstRequests: integer('burst_requests').notNull(),
    burstWindowSeconds: integer('burst_window_seconds').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: utcTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.planId, table.routeId], name: 'api_plan_route_limits_pk' }),
    index('api_plan_route_limits_route_idx').on(table.routeId),
    check('api_plan_route_limits_route_not_blank', sql`length(btrim(${table.routeId})) > 0`),
    check(
      'api_plan_route_limits_quota_check',
      sql`${table.requestsPerWindow} > 0 AND ${table.windowSeconds} > 0 AND ${table.burstRequests} > 0 AND ${table.burstWindowSeconds} > 0 AND ${table.burstWindowSeconds} <= ${table.windowSeconds}`,
    ),
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

export const apiKeyEvents = pgTable(
  'api_key_events',
  {
    id: text('id').primaryKey(),
    keyId: text('key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    principalId: text('principal_id')
      .notNull()
      .references(() => apiPrincipals.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    eventType: apiKeyEventTypeEnum('event_type').notNull(),
    actor: text('actor').notNull(),
    relatedKeyId: text('related_key_id').references(() => apiKeys.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    occurredAt: utcTimestamp('occurred_at').notNull(),
  },
  (table) => [
    index('api_key_events_key_occurred_idx').on(table.keyId, table.occurredAt),
    index('api_key_events_principal_occurred_idx').on(table.principalId, table.occurredAt),
    check('api_key_events_actor_not_blank', sql`length(btrim(${table.actor})) > 0`),
    check('api_key_events_rotation_relation_check', sql`(${table.eventType} = 'rotated') = (${table.relatedKeyId} IS NOT NULL)`),
  ],
)

export const apiQuotaUsage = pgTable(
  'api_quota_usage',
  {
    principalId: text('principal_id')
      .notNull()
      .references(() => apiPrincipals.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    routeId: text('route_id').notNull(),
    quotaKind: apiQuotaKindEnum('quota_kind').notNull(),
    windowStartedAt: utcTimestamp('window_started_at').notNull(),
    requestCount: bigint('request_count', { mode: 'bigint' }).notNull().default(sql`0`),
    updatedAt: utcTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.principalId, table.routeId, table.quotaKind, table.windowStartedAt], name: 'api_quota_usage_pk' }),
    index('api_quota_usage_window_idx').on(table.windowStartedAt),
    index('api_quota_usage_route_window_idx').on(table.routeId, table.windowStartedAt),
    check('api_quota_usage_route_not_blank', sql`length(btrim(${table.routeId})) > 0`),
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
    channel: text('channel').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    status: notificationStatusEnum('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: utcTimestamp('next_attempt_at'),
    sentAt: utcTimestamp('sent_at'),
    failure: jsonb('failure').$type<Record<string, unknown>>(),
    leaseOwner: text('lease_owner'),
    leaseToken: integer('lease_token').notNull().default(0),
    leaseExpiresAt: utcTimestamp('lease_expires_at'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('notifications_idempotency_uidx').on(table.idempotencyKey),
    index('notifications_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
    index('notifications_case_idx').on(table.caseId),
    check('notifications_attempt_count_check', sql`${table.attemptCount} >= 0`),
    check('notifications_channel_check', sql`${table.channel} IN ('email', 'webhook')`),
    check('notifications_payload_sha256_check', sql`${table.payloadSha256} ~ '^[0-9a-f]{64}$'`),
    check('notifications_lease_token_check', sql`${table.leaseToken} >= 0`),
    check(
      'notifications_lease_check',
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR
          (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
  ],
)

export const notificationDeliveryAttempts = pgTable(
  'notification_delivery_attempts',
  {
    id: text('id').primaryKey(),
    notificationId: text('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    outcome: notificationDeliveryOutcomeEnum('outcome').notNull(),
    startedAt: utcTimestamp('started_at').notNull(),
    completedAt: utcTimestamp('completed_at').notNull(),
    httpStatus: integer('http_status'),
    failure: jsonb('failure').$type<Record<string, unknown>>(),
    responseSha256: text('response_sha256'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('notification_delivery_attempts_number_uidx').on(table.notificationId, table.attemptNumber),
    index('notification_delivery_attempts_notification_idx').on(table.notificationId, table.completedAt),
    check('notification_delivery_attempts_number_check', sql`${table.attemptNumber} > 0`),
    check('notification_delivery_attempts_time_check', sql`${table.completedAt} >= ${table.startedAt}`),
    check('notification_delivery_attempts_http_check', sql`${table.httpStatus} IS NULL OR ${table.httpStatus} BETWEEN 100 AND 599`),
    check('notification_delivery_attempts_response_hash_check', sql`${table.responseSha256} IS NULL OR ${table.responseSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'notification_delivery_attempts_outcome_check',
      sql`(${table.outcome} = 'sent' AND ${table.failure} IS NULL) OR
          (${table.outcome} = 'failed' AND ${table.failure} IS NOT NULL)`,
    ),
  ],
)

export const anchorCaseEvents = pgTable(
  'anchor_case_events',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => anchorCases.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    eventType: text('event_type').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: utcTimestamp('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('anchor_case_events_case_occurred_idx').on(table.caseId, table.occurredAt),
    check('anchor_case_events_type_not_blank', sql`length(btrim(${table.eventType})) > 0`),
    check('anchor_case_events_actor_check', sql`${table.actorType} IN ('system', 'anchor', 'reviewer', 'administrator')`),
    check(
      'anchor_case_events_actor_id_check',
      sql`(${table.actorType} = 'system' AND ${table.actorId} IS NULL) OR
          (${table.actorType} <> 'system' AND length(btrim(${table.actorId})) > 0)`,
    ),
  ],
)

export const anchorClaimChallenges = pgTable(
  'anchor_claim_challenges',
  {
    id: text('id').primaryKey(),
    anchorId: text('anchor_id').notNull().references(() => anchors.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    domainId: text('domain_id').notNull().references(() => anchorDomains.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    verificationPath: text('verification_path').notNull(),
    expiresAt: utcTimestamp('expires_at').notNull(),
    consumedAt: utcTimestamp('consumed_at'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('anchor_claim_challenges_token_hash_uidx').on(table.tokenHash),
    index('anchor_claim_challenges_anchor_expiry_idx').on(table.anchorId, table.expiresAt),
    check('anchor_claim_challenges_hash_check', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('anchor_claim_challenges_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check('anchor_claim_challenges_consumed_check', sql`${table.consumedAt} IS NULL OR ${table.consumedAt} <= ${table.expiresAt}`),
  ],
)

export const anchorClaimants = pgTable(
  'anchor_claimants',
  {
    id: text('id').primaryKey(),
    anchorId: text('anchor_id').notNull().references(() => anchors.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    domainId: text('domain_id').notNull().references(() => anchorDomains.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    verifiedAt: utcTimestamp('verified_at').notNull(),
    verificationExpiresAt: utcTimestamp('verification_expires_at').notNull(),
    revokedAt: utcTimestamp('revoked_at'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('anchor_claimants_active_domain_uidx').on(table.anchorId, table.domainId).where(sql`${table.revokedAt} IS NULL`),
    index('anchor_claimants_anchor_idx').on(table.anchorId, table.verifiedAt),
    check('anchor_claimants_expiry_check', sql`${table.verificationExpiresAt} > ${table.verifiedAt}`),
    check('anchor_claimants_revoked_check', sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.verifiedAt}`),
  ],
)

export const anchorClaimSessions = pgTable(
  'anchor_claim_sessions',
  {
    id: text('id').primaryKey(),
    claimantId: text('claimant_id').notNull().references(() => anchorClaimants.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: utcTimestamp('expires_at').notNull(),
    lastUsedAt: utcTimestamp('last_used_at'),
    revokedAt: utcTimestamp('revoked_at'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('anchor_claim_sessions_token_hash_uidx').on(table.tokenHash),
    index('anchor_claim_sessions_claimant_expiry_idx').on(table.claimantId, table.expiresAt),
    check('anchor_claim_sessions_hash_check', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('anchor_claim_sessions_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
)

export const anchorClaimEvents = pgTable(
  'anchor_claim_events',
  {
    id: text('id').primaryKey(),
    anchorId: text('anchor_id').notNull().references(() => anchors.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    claimantId: text('claimant_id').references(() => anchorClaimants.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    eventType: text('event_type').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: utcTimestamp('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('anchor_claim_events_anchor_occurred_idx').on(table.anchorId, table.occurredAt),
    index('anchor_claim_events_claimant_occurred_idx').on(table.claimantId, table.occurredAt),
    check('anchor_claim_events_type_not_blank', sql`length(btrim(${table.eventType})) > 0`),
    check('anchor_claim_events_actor_check', sql`${table.actorType} IN ('system', 'claimant')`),
    check('anchor_claim_events_actor_id_check', sql`(${table.actorType} = 'system' AND ${table.actorId} IS NULL) OR (${table.actorType} = 'claimant' AND length(btrim(${table.actorId})) > 0)`),
  ],
)

export const anchorReplies = pgTable(
  'anchor_replies',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => anchorCases.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    claimantId: text('claimant_id').references(() => anchorClaimants.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    supersedesReplyId: text('supersedes_reply_id'),
    version: integer('version').notNull().default(1),
    submittedBy: text('submitted_by').notNull(),
    body: text('body').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    submittedAt: utcTimestamp('submitted_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('anchor_replies_case_submitted_idx').on(table.caseId, table.submittedAt),
    uniqueIndex('anchor_replies_case_version_uidx').on(table.caseId, table.version),
    unique('anchor_replies_identity_case_unique').on(table.id, table.caseId),
    foreignKey({
      columns: [table.supersedesReplyId, table.caseId],
      foreignColumns: [table.id, table.caseId],
      name: 'anchor_replies_supersedes_case_fk',
    }).onDelete('restrict').onUpdate('cascade'),
    check('anchor_replies_body_not_blank', sql`length(btrim(${table.body})) > 0`),
    check('anchor_replies_version_check', sql`${table.version} > 0`),
    check('anchor_replies_version_link_check', sql`(${table.version} = 1 AND ${table.supersedesReplyId} IS NULL) OR (${table.version} > 1 AND ${table.supersedesReplyId} IS NOT NULL)`),
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
    check('anchor_reviews_decision_check', sql`${table.decision} IN ('approve_public', 'withhold')`),
  ],
)

export const anchorDisputes = pgTable(
  'anchor_disputes',
  {
    id: text('id').primaryKey(),
    flagId: text('flag_id').notNull().references(() => discrepancies.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    caseId: text('case_id').references(() => anchorCases.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    claimantId: text('claimant_id').notNull().references(() => anchorClaimants.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    body: text('body').notNull(),
    status: text('status').notNull().default('open'),
    publicationState: text('publication_state').notNull().default('internal'),
    submittedAt: utcTimestamp('submitted_at').notNull(),
    resolvedAt: utcTimestamp('resolved_at'),
    createdAt: createdAt(),
  },
  (table) => [
    index('anchor_disputes_flag_submitted_idx').on(table.flagId, table.submittedAt),
    index('anchor_disputes_status_submitted_idx').on(table.status, table.submittedAt),
    check('anchor_disputes_body_not_blank', sql`length(btrim(${table.body})) > 0`),
    check('anchor_disputes_status_check', sql`${table.status} IN ('open', 'under_review', 'resolved', 'rejected')`),
    check('anchor_disputes_publication_check', sql`${table.publicationState} IN ('internal', 'approved_public')`),
    check('anchor_disputes_resolution_check', sql`(${table.status} IN ('resolved', 'rejected')) = (${table.resolvedAt} IS NOT NULL)`),
  ],
)

export const anchorEvidence = pgTable(
  'anchor_evidence',
  {
    id: text('id').primaryKey(),
    replyId: text('reply_id').references(() => anchorReplies.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    disputeId: text('dispute_id').references(() => anchorDisputes.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    kind: text('kind').notNull(),
    url: text('url'),
    storageReference: text('storage_reference'),
    contentType: text('content_type'),
    byteSize: bigint('byte_size', { mode: 'number' }),
    sha256: text('sha256'),
    scanStatus: text('scan_status').notNull(),
    scanResult: jsonb('scan_result').$type<Record<string, unknown>>(),
    scannedAt: utcTimestamp('scanned_at'),
    createdAt: createdAt(),
  },
  (table) => [
    index('anchor_evidence_reply_idx').on(table.replyId),
    index('anchor_evidence_dispute_idx').on(table.disputeId),
    index('anchor_evidence_scan_idx').on(table.scanStatus, table.createdAt),
    check('anchor_evidence_parent_check', sql`(${table.replyId} IS NOT NULL)::int + (${table.disputeId} IS NOT NULL)::int = 1`),
    check('anchor_evidence_kind_check', sql`${table.kind} IN ('link', 'upload')`),
    check('anchor_evidence_location_check', sql`(${table.kind} = 'link' AND ${table.url} ~ '^https://' AND ${table.storageReference} IS NULL AND ${table.scanStatus} = 'not_required' AND ${table.contentType} IS NULL AND ${table.byteSize} IS NULL AND ${table.sha256} IS NULL AND ${table.scanResult} IS NULL AND ${table.scannedAt} IS NULL) OR (${table.kind} = 'upload' AND ${table.url} IS NULL AND length(${table.storageReference}) BETWEEN 1 AND 512 AND ${table.storageReference} ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$' AND ${table.scanStatus} = 'clean' AND ${table.scanResult} IS NOT NULL AND ${table.scannedAt} IS NOT NULL)`),
    check('anchor_evidence_scan_status_check', sql`${table.scanStatus} IN ('not_required', 'pending', 'clean', 'rejected')`),
    check('anchor_evidence_upload_metadata_check', sql`${table.kind} = 'link' OR (${table.contentType} IN ('application/pdf', 'image/jpeg', 'image/png', 'text/plain') AND ${table.byteSize} > 0 AND ${table.byteSize} <= 5000000 AND ${table.sha256} ~ '^[0-9a-f]{64}$')`),
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
