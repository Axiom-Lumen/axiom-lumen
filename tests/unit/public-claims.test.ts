import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_PUBLIC_CLAIM_PATTERNS,
  PUBLIC_CLAIM_SURFACES,
  smokeSourceCoversDocumentedGets,
  undocumentedSmokeGaps,
} from '../../lib/release/claims'
import { loadProductionReadinessRecord } from '../../lib/release/readiness'

const recordPath = fileURLToPath(new URL('../../docs/releases/production-readiness.record.json', import.meta.url))

describe('public claims', () => {
  it('covers every documented public GET in release smoke', () => {
    expect(undocumentedSmokeGaps()).toEqual([])
    const smoke = readFileSync(fileURLToPath(new URL('../../lib/release/smoke.ts', import.meta.url)), 'utf8')
    expect(smokeSourceCoversDocumentedGets(smoke)).toBe(true)
  })

  it('keeps marketing and status copy from claiming unshipped paid or live capabilities', () => {
    for (const surface of PUBLIC_CLAIM_SURFACES) {
      const text = readFileSync(surface, 'utf8')
      for (const claim of FORBIDDEN_PUBLIC_CLAIM_PATTERNS) {
        if (claim.surfaces && !claim.surfaces.includes(surface)) continue
        expect(text, `${claim.id} in ${surface}`).not.toMatch(claim.pattern)
      }
    }
  })

  it('does not declare public v1 while the readiness record is unsigned', () => {
    const record = loadProductionReadinessRecord(recordPath)
    expect(record.public_v1_declared).toBe(false)
    expect(record.sign_offs.public_claims_review.status).toBe('accepted')
    expect(record.sign_offs.publication_legal_review.status).toBe('unsigned')
  })
})
