import { describe, expect, it } from 'vitest'
import { parseDatabaseRuntimeConfig } from '../../lib/db/client'

describe('database runtime configuration', () => {
  it('parses a PostgreSQL URL and bounded pool settings', () => {
    expect(
      parseDatabaseRuntimeConfig({
        DATABASE_URL: 'postgresql://runtime:secret@db.example/axiom',
        DATABASE_POOL_MAX: '8',
        DATABASE_IDLE_TIMEOUT_MS: '12000',
        DATABASE_CONNECTION_TIMEOUT_MS: '3000',
      }),
    ).toEqual({
      connectionString: 'postgresql://runtime:secret@db.example/axiom',
      poolMax: 8,
      idleTimeoutMs: 12000,
      connectionTimeoutMs: 3000,
    })
  })

  it('uses conservative pool defaults', () => {
    expect(parseDatabaseRuntimeConfig({ DATABASE_URL: 'postgres://runtime:secret@db.example/axiom' })).toMatchObject({
      poolMax: 5,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 5_000,
    })
  })

  it('rejects missing, non-PostgreSQL, and invalid numeric configuration without echoing credentials', () => {
    expect(() => parseDatabaseRuntimeConfig({})).toThrow('DATABASE_URL is required')
    expect(() => parseDatabaseRuntimeConfig({ DATABASE_URL: 'https://user:secret@example.com/db' })).toThrow(
      /postgres or postgresql/,
    )
    expect(() =>
      parseDatabaseRuntimeConfig({
        DATABASE_URL: 'postgresql://user:secret@example.com/db',
        DATABASE_POOL_MAX: '0',
      }),
    ).toThrow('DATABASE_POOL_MAX must be a positive integer')

    try {
      parseDatabaseRuntimeConfig({ DATABASE_URL: 'not a URL containing secret-value' })
    } catch (error) {
      expect(String(error)).not.toContain('secret-value')
    }
  })
})
