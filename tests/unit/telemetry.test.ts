import { describe, expect, it } from 'vitest'
import {
  redactTelemetryValue,
  resolveTraceContext,
  structuredLog,
  traceIdForCycle,
} from '../../lib/observability/telemetry'

describe('operational telemetry', () => {
  it('redacts credential fields and credential-bearing URLs recursively', () => {
    const redacted = redactTelemetryValue({
      authorization: 'Bearer secret',
      nested: {
        api_key: 'axl_secret',
        endpoint: 'https://user:password@example.com/read?token=secret&network=public',
        note: 'request failed at postgres://db-user:db-password@db.internal/axiom?sslkey=private',
      },
    })
    const serialized = JSON.stringify(redacted)
    expect(serialized).not.toContain('Bearer secret')
    expect(serialized).not.toContain('axl_secret')
    expect(serialized).not.toContain('password')
    expect(serialized).not.toContain('token=secret')
    expect(serialized).not.toContain('db-password')
    expect(serialized).not.toContain('sslkey=private')
    expect(serialized).toContain('REDACTED')
  })

  it('continues valid W3C traces with a new span and rejects all-zero identifiers', () => {
    const bytes = (length: number) => Buffer.alloc(length, 0xab)
    const inherited = resolveTraceContext(`00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`, bytes)
    expect(inherited.traceId).toBe('1'.repeat(32))
    expect(inherited.spanId).toBe('ab'.repeat(8))
    expect(inherited.traceparent).toBe(`00-${'1'.repeat(32)}-${'ab'.repeat(8)}-01`)
    expect(resolveTraceContext(`00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`, bytes).traceId).toBe('ab'.repeat(16))
  })

  it('writes stable cycle-correlated structured records without secret values', () => {
    const output: string[] = []
    const traceId = traceIdForCycle('cycle-a')
    expect(traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(traceIdForCycle('cycle-a')).toBe(traceId)
    structuredLog('info', 'cycle_test', {
      trace_id: traceId,
      cycle_id: 'cycle-a',
      source_id: 'source-a',
      token: 'do-not-log',
    }, { clock: () => new Date('2026-08-13T12:00:00.000Z'), write: (line) => output.push(line) })
    expect(JSON.parse(output[0]!)).toEqual({
      timestamp: '2026-08-13T12:00:00.000Z', level: 'info', event: 'cycle_test',
      trace_id: traceId, cycle_id: 'cycle-a', source_id: 'source-a', token: '[REDACTED]',
    })
  })
})
