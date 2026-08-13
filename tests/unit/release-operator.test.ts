import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OPENAPI_EXAMPLES } from '../../lib/openapi/document'
import {
  acceptReadinessSignOff,
  parseProductionReadinessRecord,
  PRODUCTION_READINESS_SCHEMA_VERSION,
} from '../../lib/release/readiness'
import { parseSnapshotEventPayload } from '../../lib/release/smoke'

const unsigned = {
  status: 'unsigned' as const,
  reviewer: null,
  recorded_at: null,
  evidence_ref: null,
  notes: null,
}
const accepted = {
  status: 'accepted' as const,
  reviewer: 'engineering',
  recorded_at: '2026-08-13T22:00:00.000Z',
  evidence_ref: 'REL-02 public-claims audit and release smoke coverage of documented GET operations',
  notes: 'recorded',
}

function baseRecord() {
  return {
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
  }
}

describe('release operator tooling', () => {
  it('parses a contract-valid snapshot event from SSE output', () => {
    const payload = parseSnapshotEventPayload(
      `retry: 1000\n\nid: 42\nevent: snapshot\ndata: ${JSON.stringify(OPENAPI_EXAMPLES.snapshotEvent)}\n\n`,
    )
    expect(payload).toEqual(OPENAPI_EXAMPLES.snapshotEvent)
  })

  it('writes an accepted sign-off to a JSON record file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'axiom-readiness-'))
    const recordPath = join(directory, 'record.json')
    writeFileSync(recordPath, `${JSON.stringify(baseRecord(), null, 2)}\n`)
    try {
      const updated = acceptReadinessSignOff(parseProductionReadinessRecord(baseRecord()), {
        id: 'restore_drill',
        reviewer: 'ops-owner',
        evidenceRef: 'restore-drill-2026-08',
        recordedAt: '2026-08-13T23:00:00.000Z',
      })
      writeFileSync(recordPath, `${JSON.stringify(updated, null, 2)}\n`)
      const reloaded = parseProductionReadinessRecord(JSON.parse(readFileSync(recordPath, 'utf8')))
      expect(reloaded.sign_offs.restore_drill.status).toBe('accepted')
      expect(reloaded.sign_offs.restore_drill.evidence_ref).toBe('restore-drill-2026-08')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
