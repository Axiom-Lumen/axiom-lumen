import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Pool, type PoolClient } from 'pg'
import { z } from 'zod'

const RESTORE_ACKNOWLEDGEMENT = 'CREATE_AND_DROP_EPHEMERAL_DATABASE'
const ENVIRONMENT_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/
const INVENTORY_TABLES = [
  'networks', 'source_definitions', 'ingest_cycles', 'retrieval_attempts', 'raw_readings',
  'source_health_samples', 'reconciliation_snapshots', 'snapshot_contributions', 'discrepancies',
  'discrepancy_events', 'anchor_verification_events', 'anchor_contact_secrets', 'anchor_case_events',
  'notification_delivery_attempts', 'anchor_claim_events', 'anchor_replies', 'anchor_reviews',
  'anchor_evidence', 'corrections', 'api_key_events', 'snapshot_events',
] as const
const EXPECTED_IMMUTABILITY_TRIGGERS = {
  anchor_case_events_append_only: 'anchor_case_events', anchor_claim_events_append_only: 'anchor_claim_events',
  anchor_contact_secrets_no_delete: 'anchor_contact_secrets', anchor_evidence_append_only: 'anchor_evidence',
  anchor_replies_append_only: 'anchor_replies', anchor_reviews_append_only: 'anchor_reviews',
  anchor_verification_events_append_only: 'anchor_verification_events', api_key_events_append_only: 'api_key_events',
  corrections_append_only: 'corrections', discrepancy_events_append_only: 'discrepancy_events',
  notification_delivery_attempts_append_only: 'notification_delivery_attempts', raw_readings_append_only: 'raw_readings',
  reconciliation_snapshots_append_only: 'reconciliation_snapshots', retrieval_attempts_append_only: 'retrieval_attempts',
  snapshot_contributions_append_only: 'snapshot_contributions', snapshot_events_append_only: 'snapshot_events',
  source_health_samples_append_only: 'source_health_samples',
} as const

const inventorySchema = z.object(Object.fromEntries(INVENTORY_TABLES.map((table) => [table, z.number().int().nonnegative()]))).strict()
const unsignedManifestSchema = z.object({
  formatVersion: z.literal(2),
  createdAt: z.string().datetime({ offset: true }),
  database: z.object({ environmentId: z.string().regex(ENVIRONMENT_ID), host: z.string().min(1), port: z.number().int().positive(), name: z.string().min(1) }).strict(),
  dump: z.object({
    format: z.literal('postgresql-custom+aes-256-gcm'),
    file: z.string().regex(/^axiom-lumen-[0-9TZ-]+-[0-9a-f]{12}\.dump\.enc$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    encryption: z.object({ algorithm: z.literal('aes-256-gcm'), keyId: z.string().regex(ENVIRONMENT_ID), initializationVector: z.string().min(16), authenticationTag: z.string().min(20) }).strict(),
  }).strict(),
  inventory: inventorySchema,
}).strict()
const backupManifestSchema = unsignedManifestSchema.extend({
  authentication: z.object({ algorithm: z.literal('hmac-sha256'), value: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
}).strict()

export type BackupManifest = z.infer<typeof backupManifestSchema>
type Inventory = z.infer<typeof inventorySchema>
type OperationsEnvironment = Readonly<Record<string, string | undefined>>
type CommandRunner = (command: string, args: readonly string[], environment: OperationsEnvironment) => Promise<void>
interface SourceSnapshot { snapshotId: string; inventory: Inventory }
type SnapshotProvider = <T>(operation: (snapshot: SourceSnapshot) => Promise<T>) => Promise<T>

function positiveInteger(name: string, value: string | undefined, fallback: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function environmentId(value: string | undefined, name: string) {
  if (!value || !ENVIRONMENT_ID.test(value)) throw new Error(`${name} must be a lowercase environment identifier`)
  return value
}

function encryptionKeys(environment: OperationsEnvironment) {
  const raw = environment.DATABASE_BACKUP_ENCRYPTION_KEYS
  if (!raw) throw new Error('DATABASE_BACKUP_ENCRYPTION_KEYS is required')
  const keys = new Map<string, Buffer>()
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':')
    const keyId = entry.slice(0, separator)
    const encoded = entry.slice(separator + 1)
    const key = Buffer.from(encoded, 'base64')
    if (separator < 1 || !ENVIRONMENT_ID.test(keyId) || key.length !== 32 || key.toString('base64') !== encoded || keys.has(keyId)) {
      throw new Error('DATABASE_BACKUP_ENCRYPTION_KEYS must contain unique key-id:canonical-base64-32-byte-key entries')
    }
    keys.set(keyId, key)
  }
  return keys
}

function activeEncryptionKey(environment: OperationsEnvironment) {
  const keyId = environmentId(environment.DATABASE_BACKUP_ACTIVE_KEY_ID, 'DATABASE_BACKUP_ACTIVE_KEY_ID')
  const key = encryptionKeys(environment).get(keyId)
  if (!key) throw new Error('DATABASE_BACKUP_ACTIVE_KEY_ID is not present in DATABASE_BACKUP_ENCRYPTION_KEYS')
  return { keyId, key }
}

function databaseConnection(raw: string | undefined, name: string) {
  if (!raw) throw new Error(`${name} is required`)
  const url = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error(`${name} must be a PostgreSQL URL with a database name`)
  const port = url.port ? positiveInteger(`${name} port`, url.port, 5432) : 5432
  const database = decodeURIComponent(url.pathname.slice(1))
  return {
    url: raw, database, identity: { host: url.hostname, port, name: database },
    environment: {
      PGHOST: url.hostname, PGPORT: String(port), PGDATABASE: database,
      ...(url.username ? { PGUSER: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
      ...(url.searchParams.get('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode')! } : {}),
      ...(url.searchParams.get('sslrootcert') ? { PGSSLROOTCERT: url.searchParams.get('sslrootcert')! } : {}),
      ...(url.searchParams.get('sslcert') ? { PGSSLCERT: url.searchParams.get('sslcert')! } : {}),
      ...(url.searchParams.get('sslkey') ? { PGSSLKEY: url.searchParams.get('sslkey')! } : {}),
    },
  }
}

const defaultRunner: CommandRunner = (command, args, environment) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], {
    env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, ...(process.env.LANG ? { LANG: process.env.LANG } : {}), ...environment },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  child.once('error', reject)
  child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`}`)))
})

function timestampForFile(date: Date) {
  if (!Number.isFinite(date.getTime())) throw new Error('backup clock must return a valid date')
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

async function sha256(file: string) {
  const hash = createHash('sha256')
  const stream = createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function assertPathAbsent(target: string) {
  try {
    await lstat(target)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`backup artifact already exists: ${path.basename(target)}`)
}

async function tableInventory(client: PoolClient | Pool) {
  const fragments = INVENTORY_TABLES.map((table) => `SELECT '${table}' AS name, count(*)::int AS count FROM public.${table}`).join(' UNION ALL ')
  const result = await client.query<{ name: string; count: number }>(fragments)
  return inventorySchema.parse(Object.fromEntries(result.rows.map((row) => [row.name, row.count])))
}

function defaultSnapshotProvider(connectionUrl: string): SnapshotProvider {
  return async (operation) => {
    const pool = new Pool({ connectionString: connectionUrl, max: 1 })
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const snapshot = await client.query<{ snapshot_id: string }>('SELECT pg_export_snapshot() AS snapshot_id')
      return await operation({ snapshotId: snapshot.rows[0]!.snapshot_id, inventory: await tableInventory(client) })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
      await pool.end()
    }
  }
}

async function encryptDump(input: string, output: string, keyId: string, key: Buffer, random: (size: number) => Buffer) {
  const initializationVector = random(12)
  const cipher = createCipheriv('aes-256-gcm', key, initializationVector)
  await pipeline(createReadStream(input), cipher, createWriteStream(output, { flags: 'wx', mode: 0o600 }))
  return { algorithm: 'aes-256-gcm' as const, keyId, initializationVector: initializationVector.toString('base64'), authenticationTag: cipher.getAuthTag().toString('base64') }
}

async function decryptDump(input: string, output: string, key: Buffer, encryption: BackupManifest['dump']['encryption']) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encryption.initializationVector, 'base64'))
  decipher.setAuthTag(Buffer.from(encryption.authenticationTag, 'base64'))
  await pipeline(createReadStream(input), decipher, createWriteStream(output, { flags: 'wx', mode: 0o600 }))
}

function authenticateManifest(unsigned: z.infer<typeof unsignedManifestSchema>, key: Buffer) {
  const authenticationKey = createHash('sha256').update('axiom-lumen-backup-manifest\0').update(key).digest()
  return createHmac('sha256', authenticationKey).update(JSON.stringify(unsigned)).digest('hex')
}

export async function createDatabaseBackup(input: {
  environment?: OperationsEnvironment; clock?: () => Date; randomId?: () => string; randomBytes?: (size: number) => Buffer
  run?: CommandRunner; withSourceSnapshot?: SnapshotProvider
}) {
  const environment = input.environment ?? process.env
  if (!environment.DATABASE_BACKUP_DIRECTORY || !path.isAbsolute(environment.DATABASE_BACKUP_DIRECTORY)) throw new Error('DATABASE_BACKUP_DIRECTORY must be an absolute path')
  const outputDirectory = path.resolve(environment.DATABASE_BACKUP_DIRECTORY)
  if (outputDirectory === path.parse(outputDirectory).root) throw new Error('DATABASE_BACKUP_DIRECTORY cannot be a filesystem root')
  const connection = databaseConnection(environment.DATABASE_BACKUP_URL, 'DATABASE_BACKUP_URL')
  const backupEnvironmentId = environmentId(environment.DATABASE_BACKUP_ENVIRONMENT_ID, 'DATABASE_BACKUP_ENVIRONMENT_ID')
  const activeKey = activeEncryptionKey(environment)
  const now = (input.clock ?? (() => new Date()))()
  const suffix = (input.randomId ?? randomUUID)().replaceAll('-', '').slice(0, 12).toLowerCase()
  if (!/^[0-9a-f]{12}$/.test(suffix)) throw new Error('backup random ID must provide 12 hexadecimal characters')
  const file = `axiom-lumen-${timestampForFile(now)}-${suffix}.dump.enc`
  const encryptedPath = path.join(outputDirectory, file)
  const plaintextPath = `${encryptedPath}.plaintext.partial`
  const manifestPath = `${encryptedPath}.manifest.json`
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  await chmod(outputDirectory, 0o700)
  for (const target of [encryptedPath, manifestPath, plaintextPath]) await assertPathAbsent(target)
  try {
    return await (input.withSourceSnapshot ?? defaultSnapshotProvider(connection.url))(async (snapshot) => {
      await writeFile(plaintextPath, '', { flag: 'wx', mode: 0o600 })
      await (input.run ?? defaultRunner)('pg_dump', ['--format=custom', '--compress=9', '--no-owner', '--no-privileges', '--snapshot', snapshot.snapshotId, '--file', plaintextPath], connection.environment)
      const plaintextStat = await lstat(plaintextPath)
      if (!plaintextStat.isFile() || plaintextStat.isSymbolicLink() || plaintextStat.size === 0) throw new Error('pg_dump produced an invalid backup')
      const encryption = await encryptDump(plaintextPath, encryptedPath, activeKey.keyId, activeKey.key, input.randomBytes ?? randomBytes)
      await unlink(plaintextPath)
      const unsigned = unsignedManifestSchema.parse({
        formatVersion: 2, createdAt: now.toISOString(),
        database: { environmentId: backupEnvironmentId, ...connection.identity },
        dump: { format: 'postgresql-custom+aes-256-gcm', file, sha256: await sha256(encryptedPath), encryption },
        inventory: snapshot.inventory,
      })
      const manifest = backupManifestSchema.parse({ ...unsigned, authentication: { algorithm: 'hmac-sha256', value: authenticateManifest(unsigned, activeKey.key) } })
      await writeFile(`${manifestPath}.partial`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(`${manifestPath}.partial`, manifestPath)
      return { dumpPath: encryptedPath, manifestPath, manifest }
    })
  } catch (error) {
    await Promise.all([plaintextPath, encryptedPath, `${manifestPath}.partial`].map((target) => unlink(target).catch(() => undefined)))
    throw error
  }
}

export async function verifyBackupArtifact(dumpPath: string, environment: OperationsEnvironment = process.env) {
  const resolved = path.resolve(dumpPath)
  const dumpStat = await lstat(resolved)
  if (!dumpStat.isFile() || dumpStat.isSymbolicLink() || dumpStat.size === 0) throw new Error('backup dump must be a non-empty regular file')
  const manifestPath = `${resolved}.manifest.json`
  const manifestStat = await lstat(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size === 0 || manifestStat.size > 65_536) throw new Error('backup manifest must be a bounded regular file')
  const manifest = backupManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  if (path.basename(resolved) !== manifest.dump.file) throw new Error('backup manifest filename does not match the dump')
  const { authentication, ...unsigned } = manifest
  const key = encryptionKeys(environment).get(manifest.dump.encryption.keyId)
  if (!key) throw new Error(`backup encryption key ${manifest.dump.encryption.keyId} is unavailable`)
  const expectedAuthentication = authenticateManifest(unsignedManifestSchema.parse(unsigned), key)
  if (!timingSafeEqual(Buffer.from(authentication.value, 'hex'), Buffer.from(expectedAuthentication, 'hex'))) throw new Error('backup manifest authentication failed')
  if (await sha256(resolved) !== manifest.dump.sha256) throw new Error('backup checksum verification failed')
  return manifest
}

export async function checkLatestDatabaseBackup(environment: OperationsEnvironment = process.env, now = new Date()) {
  const directory = environment.DATABASE_BACKUP_DIRECTORY
  if (!directory || !path.isAbsolute(directory)) throw new Error('DATABASE_BACKUP_DIRECTORY must be an absolute path')
  const maximumAgeHours = positiveInteger('DATABASE_BACKUP_MAXIMUM_AGE_HOURS', environment.DATABASE_BACKUP_MAXIMUM_AGE_HOURS, 26)
  if (!Number.isFinite(now.getTime())) throw new Error('backup check clock must be valid')
  const files = (await readdir(directory)).filter((file) => /^axiom-lumen-.*\.dump\.enc$/.test(file)).sort()
  if (files.length === 0) throw new Error('no encrypted database backups are available')
  const candidates = await Promise.all(files.map(async (file) => backupManifestSchema.parse(JSON.parse(await readFile(path.join(directory, `${file}.manifest.json`), 'utf8')))))
  const candidate = candidates.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]!
  const latest = await verifyBackupArtifact(path.join(directory, candidate.dump.file), environment)
  const ageHours = Math.max(0, now.getTime() - Date.parse(latest.createdAt)) / 3_600_000
  if (ageHours > maximumAgeHours) throw new Error('latest database backup exceeds its maximum age')
  return { file: latest.dump.file, createdAt: latest.createdAt, ageHours: Number(ageHours.toFixed(3)), maximumAgeHours }
}

async function assertMutationRejected(restored: Pool) {
  const client = await restored.connect()
  try {
    await client.query('BEGIN')
    try {
      await client.query('UPDATE retrieval_attempts SET id = id')
      throw new Error('restored database allowed mutation of append-only evidence')
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === '55000')) throw error
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
  }
}

export async function runDatabaseRestoreDrill(input: {
  dumpPath: string; environment?: OperationsEnvironment; randomId?: () => string; run?: CommandRunner
  allowSourceServerForTest?: boolean
}) {
  const environment = input.environment ?? process.env
  if (input.allowSourceServerForTest && process.env.NODE_ENV !== 'test') throw new Error('source-server restore override is restricted to tests')
  if (environment.DATABASE_RESTORE_DRILL_ACK !== RESTORE_ACKNOWLEDGEMENT) throw new Error(`DATABASE_RESTORE_DRILL_ACK must equal ${RESTORE_ACKNOWLEDGEMENT}`)
  const manifest = await verifyBackupArtifact(input.dumpPath, environment)
  const connection = databaseConnection(environment.DATABASE_RESTORE_ADMIN_URL, 'DATABASE_RESTORE_ADMIN_URL')
  if (connection.database !== 'postgres') throw new Error('DATABASE_RESTORE_ADMIN_URL must select the postgres maintenance database')
  const restoreEnvironmentId = environmentId(environment.DATABASE_RESTORE_ENVIRONMENT_ID, 'DATABASE_RESTORE_ENVIRONMENT_ID')
  const sameServer = connection.identity.host === manifest.database.host && connection.identity.port === manifest.database.port
  if (!input.allowSourceServerForTest && (sameServer || restoreEnvironmentId === manifest.database.environmentId)) throw new Error('restore drills must target an isolated environment and database server')
  const temporaryDirectory = environment.DATABASE_RESTORE_TEMP_DIRECTORY ?? os.tmpdir()
  if (!path.isAbsolute(temporaryDirectory) || path.resolve(temporaryDirectory) === path.parse(path.resolve(temporaryDirectory)).root) throw new Error('DATABASE_RESTORE_TEMP_DIRECTORY must be an absolute non-root path')
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 })
  const suffix = (input.randomId ?? randomUUID)().replaceAll('-', '').slice(0, 16).toLowerCase()
  if (!/^[0-9a-f]{16}$/.test(suffix)) throw new Error('restore random ID must provide 16 hexadecimal characters')
  const database = `axiom_restore_${suffix}`
  const plaintextPath = path.join(temporaryDirectory, `${database}.dump.partial`)
  const admin = new Pool({ connectionString: connection.url, max: 1 })
  let created = false
  try {
    const key = encryptionKeys(environment).get(manifest.dump.encryption.keyId)
    if (!key) throw new Error(`backup encryption key ${manifest.dump.encryption.keyId} is unavailable`)
    await decryptDump(path.resolve(input.dumpPath), plaintextPath, key, manifest.dump.encryption)
    await admin.query(`CREATE DATABASE "${database}"`)
    created = true
    await (input.run ?? defaultRunner)('pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', database, plaintextPath], { ...connection.environment, PGDATABASE: database })
    const restoredUrl = new URL(connection.url); restoredUrl.pathname = `/${database}`
    const restored = new Pool({ connectionString: restoredUrl.toString(), max: 1 })
    try {
      const inventory = await tableInventory(restored)
      if (JSON.stringify(inventory) !== JSON.stringify(manifest.inventory)) throw new Error('restored database inventory does not match the backup snapshot')
      const triggerRows = await restored.query<{ tgname: string; table_name: string; tgenabled: string }>(`
        SELECT triggers.tgname, tables.relname AS table_name, triggers.tgenabled
        FROM pg_trigger triggers JOIN pg_class tables ON tables.oid = triggers.tgrelid
        WHERE NOT triggers.tgisinternal AND (triggers.tgname LIKE '%_append_only' OR triggers.tgname LIKE '%_no_delete')
        ORDER BY triggers.tgname
      `)
      const triggers = triggerRows.rows.map((row) => `${row.tgname}:${row.table_name}:${row.tgenabled}`)
      const expectedTriggers = Object.entries(EXPECTED_IMMUTABILITY_TRIGGERS).map(([name, table]) => `${name}:${table}:O`).sort()
      if (JSON.stringify(triggers) !== JSON.stringify(expectedTriggers)) throw new Error('restored database immutability trigger set is incomplete, disabled, or attached incorrectly')
      await assertMutationRejected(restored)
      if (inventory.networks < 1) throw new Error('restored database has no configured network')
      return { database, inventory, immutabilityTriggers: triggers.length }
    } finally { await restored.end() }
  } finally {
    try {
      await unlink(plaintextPath).catch(() => undefined)
      if (created) {
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [database])
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
      }
    } finally { await admin.end() }
  }
}
