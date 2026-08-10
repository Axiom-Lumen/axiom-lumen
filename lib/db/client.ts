import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export interface DatabaseRuntimeConfig {
  connectionString: string
  poolMax: number
  idleTimeoutMs: number
  connectionTimeoutMs: number
}

function positiveInteger(name: string, value: string | undefined, fallback: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

export function parseDatabaseRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseRuntimeConfig {
  const connectionString = environment.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')

  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use the postgres or postgresql scheme')
  }

  return {
    connectionString,
    poolMax: positiveInteger('DATABASE_POOL_MAX', environment.DATABASE_POOL_MAX, 5),
    idleTimeoutMs: positiveInteger('DATABASE_IDLE_TIMEOUT_MS', environment.DATABASE_IDLE_TIMEOUT_MS, 30_000),
    connectionTimeoutMs: positiveInteger(
      'DATABASE_CONNECTION_TIMEOUT_MS',
      environment.DATABASE_CONNECTION_TIMEOUT_MS,
      5_000,
    ),
  }
}

/** Creates one bounded pool for a worker or web process; callers own shutdown through pool.end(). */
export function createDatabaseClient(config = parseDatabaseRuntimeConfig()) {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.poolMax,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
  })
  return { pool, db: drizzle({ client: pool, schema }) }
}

export type DatabaseClient = ReturnType<typeof createDatabaseClient>
