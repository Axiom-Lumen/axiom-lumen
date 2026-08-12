import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClamAvScanner, createContentAddressedEvidenceStorage } from '../../lib/anchor/evidence-runtime'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('anchor evidence runtime', () => {
  it('executes the managed scanner and distinguishes clean from infected bytes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'axiom-evidence-scanner-'))
    temporaryDirectories.push(directory)
    const executable = path.join(directory, 'fixture-scanner')
    await writeFile(executable, '#!/bin/sh\ninput=$(cat)\ncase "$input" in infected*) echo "stdin: Fixture FOUND"; exit 1;; *) echo "stdin: OK"; exit 0;; esac\n')
    await chmod(executable, 0o700)
    const scanner = createClamAvScanner(executable)
    await expect(scanner.scan(new TextEncoder().encode('clean'), 'text/plain')).resolves.toMatchObject({ clean: true })
    await expect(scanner.scan(new TextEncoder().encode('infected sample'), 'text/plain')).resolves.toMatchObject({ clean: false, signature: expect.stringContaining('FOUND') })
  })

  it('stores clean bytes under a private content-addressed path idempotently', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'axiom-evidence-store-'))
    temporaryDirectories.push(directory)
    const storage = createContentAddressedEvidenceStorage(directory)
    const sha256 = 'a'.repeat(64)
    const reference = await storage.put({ bytes: new TextEncoder().encode('evidence'), contentType: 'text/plain', sha256 })
    expect(reference).toBe(`sha256/aa/${sha256}`)
    await expect(storage.put({ bytes: new TextEncoder().encode('evidence'), contentType: 'text/plain', sha256 })).resolves.toBe(reference)
    await expect(readFile(path.join(directory, reference), 'utf8')).resolves.toBe('evidence')
  })
})
