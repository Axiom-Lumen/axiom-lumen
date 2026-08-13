import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkLatestDatabaseBackup, createDatabaseBackup, runDatabaseRestoreDrill, verifyBackupArtifact } from '../../lib/operations/database-backup'

const temporaryDirectories: string[] = []
const encryptionKey = Buffer.alloc(32, 7).toString('base64')
const keyEnvironment = { DATABASE_BACKUP_ENCRYPTION_KEYS: `backup-key:${encryptionKey}`, DATABASE_BACKUP_ACTIVE_KEY_ID: 'backup-key' }
const inventory = {
  networks: 1, source_definitions: 0, ingest_cycles: 0, retrieval_attempts: 0, raw_readings: 0,
  source_health_samples: 0, reconciliation_snapshots: 0, snapshot_contributions: 0, discrepancies: 0,
  discrepancy_events: 0, anchor_verification_events: 0, anchor_contact_secrets: 0, anchor_case_events: 0,
  notification_delivery_attempts: 0, anchor_claim_events: 0, anchor_replies: 0, anchor_reviews: 0,
  anchor_evidence: 0, corrections: 0, api_key_events: 1, snapshot_events: 0,
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'axiom-backup-test-'))
  temporaryDirectories.push(directory)
  return directory
}

const sourceSnapshot = async <T>(operation: (snapshot: { snapshotId: string; inventory: typeof inventory }) => Promise<T>) => operation({ snapshotId: '00000003-0000001B-1', inventory })

describe('database backup operations', () => {
  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('creates an encrypted authenticated manifest without exposing credentials and verifies it', async () => {
    const directory = await temporaryDirectory()
    const calls: Array<{ command: string; args: readonly string[]; environment: Readonly<Record<string, string | undefined>> }> = []
    const environment = {
      DATABASE_BACKUP_URL: 'postgresql://backup-user:super-secret@db.internal:5433/axiom_lumen?sslmode=require',
      DATABASE_BACKUP_DIRECTORY: directory,
      DATABASE_BACKUP_ENVIRONMENT_ID: 'production-primary',
      ...keyEnvironment,
    }
    const result = await createDatabaseBackup({
      environment, withSourceSnapshot: sourceSnapshot,
      clock: () => new Date('2026-08-13T12:00:00.000Z'), randomId: () => 'abcdef12345600000000000000000000',
      randomBytes: () => Buffer.alloc(12, 3),
      async run(command, args, childEnvironment) {
        calls.push({ command, args, environment: childEnvironment })
        await writeFile(args[args.indexOf('--file') + 1]!, 'portable custom dump')
      },
    })

    expect(calls[0]).toMatchObject({ command: 'pg_dump', environment: { PGHOST: 'db.internal', PGDATABASE: 'axiom_lumen', PGPASSWORD: 'super-secret' } })
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['--snapshot', '00000003-0000001B-1']))
    expect(calls[0]!.args.join(' ')).not.toContain('super-secret')
    expect(result.dumpPath).toMatch(/\.dump\.enc$/)
    expect(await readFile(result.dumpPath, 'utf8')).not.toContain('portable custom dump')
    const serialized = await readFile(result.manifestPath, 'utf8')
    expect(serialized).not.toContain('backup-user')
    expect(serialized).not.toContain('super-secret')
    expect(result.manifest.inventory.api_key_events).toBe(1)
    await expect(verifyBackupArtifact(result.dumpPath, environment)).resolves.toEqual(result.manifest)
    await expect(checkLatestDatabaseBackup({ ...environment, DATABASE_BACKUP_MAXIMUM_AGE_HOURS: '26' }, new Date('2026-08-14T13:00:00Z'))).resolves.toMatchObject({ file: result.manifest.dump.file, ageHours: 25 })
    await expect(checkLatestDatabaseBackup(environment, new Date('2026-08-14T15:00:01Z'))).rejects.toThrow(/maximum age/)
  })

  it('rejects changed dumps, changed manifests, unsafe paths, and invalid keys', async () => {
    const directory = await temporaryDirectory()
    const environment = {
      DATABASE_BACKUP_URL: 'postgresql://backup@db.internal/axiom', DATABASE_BACKUP_DIRECTORY: directory,
      DATABASE_BACKUP_ENVIRONMENT_ID: 'test-source', ...keyEnvironment,
    }
    const result = await createDatabaseBackup({ environment, withSourceSnapshot: sourceSnapshot, randomId: () => 'abcdef12345600000000000000000000', async run(_command, args) { await writeFile(args[args.indexOf('--file') + 1]!, 'original') } })
    await writeFile(result.dumpPath, 'changed')
    await expect(verifyBackupArtifact(result.dumpPath, environment)).rejects.toThrow(/checksum/)

    const second = await createDatabaseBackup({ environment, withSourceSnapshot: sourceSnapshot, randomId: () => 'abcdef12345700000000000000000000', async run(_command, args) { await writeFile(args[args.indexOf('--file') + 1]!, 'original') } })
    const manifest = JSON.parse(await readFile(second.manifestPath, 'utf8')); manifest.database.environmentId = 'tampered'
    await writeFile(second.manifestPath, JSON.stringify(manifest))
    await expect(verifyBackupArtifact(second.dumpPath, environment)).rejects.toThrow(/authentication/)
    await expect(createDatabaseBackup({ environment: { ...environment, DATABASE_BACKUP_DIRECTORY: '/' } })).rejects.toThrow(/filesystem root/)
    await expect(createDatabaseBackup({ environment: { ...environment, DATABASE_BACKUP_ENCRYPTION_KEYS: 'backup-key:bad' } })).rejects.toThrow(/32-byte-key/)
  })

  it('never overwrites an existing backup pair', async () => {
    const directory = await temporaryDirectory()
    const environment = { DATABASE_BACKUP_URL: 'postgresql://backup@db.internal/axiom', DATABASE_BACKUP_DIRECTORY: directory, DATABASE_BACKUP_ENVIRONMENT_ID: 'test-source', ...keyEnvironment }
    const options = { environment, withSourceSnapshot: sourceSnapshot, clock: () => new Date('2026-08-13T12:00:00Z'), randomId: () => 'abcdef12345600000000000000000000', async run(_command: string, args: readonly string[]) { await writeFile(args[args.indexOf('--file') + 1]!, 'original') } }
    const first = await createDatabaseBackup(options)
    await expect(createDatabaseBackup(options)).rejects.toThrow(/already exists/)
    await expect(verifyBackupArtifact(first.dumpPath, environment)).resolves.toEqual(first.manifest)
  })

  it('requires acknowledgement and rejects the source server as a restore target', async () => {
    await expect(runDatabaseRestoreDrill({ dumpPath: '/tmp/not-read.dump', environment: { DATABASE_RESTORE_ADMIN_URL: 'postgresql://admin@restore/postgres' } })).rejects.toThrow(/DATABASE_RESTORE_DRILL_ACK/)
    const directory = await temporaryDirectory()
    const environment = { DATABASE_BACKUP_URL: 'postgresql://backup@same-host/axiom', DATABASE_BACKUP_DIRECTORY: directory, DATABASE_BACKUP_ENVIRONMENT_ID: 'production-primary', ...keyEnvironment }
    const backup = await createDatabaseBackup({ environment, withSourceSnapshot: sourceSnapshot, randomId: () => 'abcdef12345600000000000000000000', async run(_command, args) { await writeFile(args[args.indexOf('--file') + 1]!, 'original') } })
    await expect(runDatabaseRestoreDrill({ dumpPath: backup.dumpPath, environment: { ...keyEnvironment, DATABASE_RESTORE_ADMIN_URL: 'postgresql://admin@same-host/postgres', DATABASE_RESTORE_ENVIRONMENT_ID: 'restore-isolated', DATABASE_RESTORE_DRILL_ACK: 'CREATE_AND_DROP_EPHEMERAL_DATABASE' } })).rejects.toThrow(/isolated/)
  })
})
