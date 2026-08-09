import { describe, expect, it } from 'vitest'
import {
  computeAgeSeconds,
  computeEffectiveWeight,
  computeWeightFromAge,
  selectObservationTimestamp,
} from '../../lib/reconcile/staleness'

const now = new Date('2026-08-09T12:01:00.000Z')

describe('staleness weighting', () => {
  it('prefers and normalizes a valid source timestamp', () => {
    expect(
      selectObservationTimestamp({
        sourceTimestamp: '2026-08-09T13:00:30+01:00',
        retrievedAt: '2026-08-09T12:00:40Z',
      }),
    ).toEqual({
      timestamp: '2026-08-09T12:00:30.000Z',
      timestampMs: Date.parse('2026-08-09T12:00:30Z'),
      basis: 'source',
    })
  })

  it.each([null, undefined, 'not-a-date'])('falls back to retrieval time for source timestamp %s', (sourceTimestamp) => {
    expect(
      selectObservationTimestamp({ sourceTimestamp, retrievedAt: '2026-08-09T12:00:40Z' }),
    ).toMatchObject({ timestamp: '2026-08-09T12:00:40.000Z', basis: 'retrieved' })
  })

  it('rejects observations with no valid timestamp', () => {
    expect(() =>
      selectObservationTimestamp({ sourceTimestamp: 'bad', retrievedAt: 'also-bad' }),
    ).toThrow(/requires a valid source or retrieval timestamp/)
  })

  it('clamps future timestamps to zero age', () => {
    expect(computeAgeSeconds({ timestampMs: Date.parse('2026-08-09T12:02:00Z'), now })).toBe(0)
  })

  it('returns base weight at age zero and halves it each half-life', () => {
    expect(computeWeightFromAge({ baseWeight: 0.85, ageSeconds: 0, halfLifeSeconds: 30 })).toBe(0.85)
    expect(computeWeightFromAge({ baseWeight: 1, ageSeconds: 30, halfLifeSeconds: 30 })).toBeCloseTo(0.5)
    expect(computeWeightFromAge({ baseWeight: 1, ageSeconds: 60, halfLifeSeconds: 30 })).toBeCloseTo(0.25)
  })

  it('returns zero for a zero-weight source', () => {
    expect(computeWeightFromAge({ baseWeight: 0, ageSeconds: 10, halfLifeSeconds: 30 })).toBe(0)
  })

  it('approaches zero for very old data without producing NaN', () => {
    const weight = computeWeightFromAge({ baseWeight: 1, ageSeconds: 1_000_000, halfLifeSeconds: 30 })
    expect(Number.isNaN(weight)).toBe(false)
    expect(weight).toBeGreaterThanOrEqual(0)
    expect(weight).toBeLessThan(1e-100)
  })

  it.each([
    { baseWeight: -1, ageSeconds: 0, halfLifeSeconds: 30 },
    { baseWeight: Number.NaN, ageSeconds: 0, halfLifeSeconds: 30 },
    { baseWeight: 1, ageSeconds: -1, halfLifeSeconds: 30 },
    { baseWeight: 1, ageSeconds: Number.POSITIVE_INFINITY, halfLifeSeconds: 30 },
    { baseWeight: 1, ageSeconds: 0, halfLifeSeconds: 0 },
  ])('rejects invalid decay input %#', (input) => {
    expect(() => computeWeightFromAge(input)).toThrow()
  })

  it('returns the selected timestamp, age, and effective weight for audit use', () => {
    expect(
      computeEffectiveWeight({
        baseWeight: 1,
        sourceTimestamp: '2026-08-09T12:00:30Z',
        retrievedAt: '2026-08-09T12:00:40Z',
        now,
        halfLifeSeconds: 30,
      }),
    ).toMatchObject({
      timestamp: '2026-08-09T12:00:30.000Z',
      basis: 'source',
      ageSeconds: 30,
      effectiveWeight: 0.5,
    })
  })
})
