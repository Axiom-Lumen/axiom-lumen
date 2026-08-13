import { readFileSync } from 'node:fs'
import { z } from 'zod'

export const PRODUCTION_READINESS_SCHEMA_VERSION = 'axiom-production-readiness-v1' as const
export const PRODUCTION_READINESS_RECORD_PATH = 'docs/releases/production-readiness.record.json'

export const PRODUCTION_READINESS_SIGN_OFF_IDS = [
  'restore_drill',
  'incident_exercise',
  'security_review',
  'methodology_fixture_review',
  'publication_legal_review',
  'public_claims_review',
  'slo_oncall_rollback_owners',
] as const

export type ProductionReadinessSignOffId = (typeof PRODUCTION_READINESS_SIGN_OFF_IDS)[number]

const signOffSchema = z.object({
  status: z.enum(['unsigned', 'accepted']),
  reviewer: z.string().min(1).max(120).nullable(),
  recorded_at: z.string().datetime().nullable(),
  evidence_ref: z.string().min(1).max(500).nullable(),
  notes: z.string().max(2000).nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === 'unsigned') {
    if (value.reviewer !== null || value.recorded_at !== null || value.evidence_ref !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unsigned sign-offs cannot record a reviewer, timestamp, or evidence reference',
      })
    }
    return
  }
  if (!value.reviewer || !value.recorded_at || !value.evidence_ref) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'accepted sign-offs require reviewer, recorded_at, and evidence_ref',
    })
  }
})

const signOffsSchema = z.object({
  restore_drill: signOffSchema,
  incident_exercise: signOffSchema,
  security_review: signOffSchema,
  methodology_fixture_review: signOffSchema,
  publication_legal_review: signOffSchema,
  public_claims_review: signOffSchema,
  slo_oncall_rollback_owners: signOffSchema,
}).strict()

export const productionReadinessRecordSchema = z.object({
  schema_version: z.literal(PRODUCTION_READINESS_SCHEMA_VERSION),
  public_v1_declared: z.boolean(),
  sign_offs: signOffsSchema,
}).strict().superRefine((value, context) => {
  if (!value.public_v1_declared) return
  for (const id of PRODUCTION_READINESS_SIGN_OFF_IDS) {
    if (value.sign_offs[id].status !== 'accepted') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `public v1 cannot be declared while ${id} is unsigned`,
      })
    }
  }
})

export type ProductionReadinessRecord = z.infer<typeof productionReadinessRecordSchema>

export function parseProductionReadinessRecord(value: unknown): ProductionReadinessRecord {
  return productionReadinessRecordSchema.parse(value)
}

export function loadProductionReadinessRecord(
  path = PRODUCTION_READINESS_RECORD_PATH,
): ProductionReadinessRecord {
  return parseProductionReadinessRecord(JSON.parse(readFileSync(path, 'utf8')))
}

export function productionReadinessBlockers(record: ProductionReadinessRecord): ProductionReadinessSignOffId[] {
  return PRODUCTION_READINESS_SIGN_OFF_IDS.filter((id) => record.sign_offs[id].status !== 'accepted')
}

export function evaluateProductionReadiness(record: ProductionReadinessRecord) {
  const blockers = productionReadinessBlockers(record)
  return {
    ready: blockers.length === 0,
    public_v1_declared: record.public_v1_declared,
    blockers,
  }
}

export interface PromotionPolicyInput {
  namedPartyPublicationEnabled: boolean
}

export function assertPromotionPolicy(
  record: ProductionReadinessRecord,
  input: PromotionPolicyInput,
) {
  if (input.namedPartyPublicationEnabled && record.sign_offs.publication_legal_review.status !== 'accepted') {
    throw new Error('named-party publication requires an accepted publication_legal_review sign-off')
  }
  if (record.public_v1_declared && !evaluateProductionReadiness(record).ready) {
    throw new Error('public v1 is declared while production-readiness sign-offs remain unsigned')
  }
}

export function acceptReadinessSignOff(
  record: ProductionReadinessRecord,
  input: {
    id: ProductionReadinessSignOffId
    reviewer: string
    evidenceRef: string
    recordedAt?: string
    notes?: string | null
  },
): ProductionReadinessRecord {
  const recordedAt = input.recordedAt ?? new Date().toISOString()
  return parseProductionReadinessRecord({
    ...record,
    sign_offs: {
      ...record.sign_offs,
      [input.id]: {
        status: 'accepted',
        reviewer: input.reviewer,
        recorded_at: recordedAt,
        evidence_ref: input.evidenceRef,
        notes: input.notes ?? record.sign_offs[input.id].notes,
      },
    },
  })
}
