import { describe, expect, it } from 'vitest'
import {
  acceptReadinessSignOff,
  assertPromotionPolicy,
  evaluateProductionReadiness,
  parseProductionReadinessRecord,
  PRODUCTION_READINESS_SCHEMA_VERSION,
} from '../../lib/release/readiness'

const unsigned = {
  status: 'unsigned' as const,
  reviewer: null,
  recorded_at: null,
  evidence_ref: null,
  notes: null,
}
const accepted = {
  status: 'accepted' as const,
  reviewer: 'ops-owner',
  recorded_at: '2026-08-13T22:00:00.000Z',
  evidence_ref: 'drill-log-1',
  notes: 'recorded',
}

function record(overrides: Record<string, unknown> = {}) {
  return parseProductionReadinessRecord({
    schema_version: PRODUCTION_READINESS_SCHEMA_VERSION,
    public_v1_declared: false,
    sign_offs: {
      restore_drill: unsigned,
      incident_exercise: unsigned,
      security_review: unsigned,
      methodology_fixture_review: unsigned,
      publication_legal_review: unsigned,
      public_claims_review: accepted,
      slo_oncall_rollback_owners: unsigned,
    },
    ...overrides,
  })
}

describe('production readiness record', () => {
  it('stays blocked until every required sign-off is accepted', () => {
    const evaluation = evaluateProductionReadiness(record())
    expect(evaluation.ready).toBe(false)
    expect(evaluation.public_v1_declared).toBe(false)
    expect(evaluation.blockers).toEqual([
      'restore_drill',
      'incident_exercise',
      'security_review',
      'methodology_fixture_review',
      'publication_legal_review',
      'slo_oncall_rollback_owners',
    ])
  })

  it('rejects a public v1 declaration while any sign-off is unsigned', () => {
    expect(() => record({ public_v1_declared: true })).toThrow(/public v1 cannot be declared/)
  })

  it('rejects accepted sign-offs that omit reviewer evidence', () => {
    expect(() => record({
      sign_offs: {
        restore_drill: unsigned,
        incident_exercise: unsigned,
        security_review: unsigned,
        methodology_fixture_review: unsigned,
        publication_legal_review: unsigned,
        public_claims_review: { ...accepted, evidence_ref: null },
        slo_oncall_rollback_owners: unsigned,
      },
    })).toThrow(/evidence_ref/)
  })

  it('becomes ready only after every sign-off is accepted', () => {
    const complete = parseProductionReadinessRecord({
      schema_version: PRODUCTION_READINESS_SCHEMA_VERSION,
      public_v1_declared: true,
      sign_offs: {
        restore_drill: accepted,
        incident_exercise: accepted,
        security_review: accepted,
        methodology_fixture_review: accepted,
        publication_legal_review: accepted,
        public_claims_review: accepted,
        slo_oncall_rollback_owners: accepted,
      },
    })
    expect(evaluateProductionReadiness(complete)).toEqual({
      ready: true,
      public_v1_declared: true,
      blockers: [],
    })
  })

  it('blocks named-party publication until legal review is accepted', () => {
    expect(() => assertPromotionPolicy(record(), {
      namedPartyPublicationEnabled: true,
    })).toThrow(/publication_legal_review/)
    expect(() => assertPromotionPolicy(record({
      sign_offs: {
        ...record().sign_offs,
        publication_legal_review: accepted,
      },
    }), {
      namedPartyPublicationEnabled: true,
    })).not.toThrow()
  })

  it('records an accepted sign-off with reviewer evidence', () => {
    const updated = acceptReadinessSignOff(record(), {
      id: 'restore_drill',
      reviewer: 'ops-owner',
      evidenceRef: 'restore-drill-2026-08',
      recordedAt: '2026-08-13T23:00:00.000Z',
    })
    expect(updated.sign_offs.restore_drill).toMatchObject({
      status: 'accepted',
      reviewer: 'ops-owner',
      evidence_ref: 'restore-drill-2026-08',
    })
  })
})
