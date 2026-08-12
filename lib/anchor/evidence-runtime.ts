import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { EvidenceScanner, EvidenceStorage } from './claims'

function boundedOutput(chunks: Buffer[], chunk: Buffer) {
  if (chunks.reduce((total, item) => total + item.length, 0) < 8_192) chunks.push(chunk.subarray(0, 8_192))
}

/** Concrete scan-before-store adapter using the locally managed ClamAV executable. */
export function createClamAvScanner(executable = 'clamscan'): EvidenceScanner {
  return {
    async scan(bytes, contentType) {
      return new Promise((resolve, reject) => {
        const child = spawn(executable, ['--no-summary', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
        const output: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => boundedOutput(output, chunk))
        child.stderr.on('data', (chunk: Buffer) => boundedOutput(output, chunk))
        child.stdin.once('error', (error) => reject(new Error(`malware scanner input failed: ${error.message}`)))
        child.once('error', (error) => reject(new Error(`malware scanner could not start: ${error.message}`)))
        child.once('close', (code, signal) => {
          const result = Buffer.concat(output).toString('utf8').trim()
          if (signal || (code !== 0 && code !== 1)) {
            reject(new Error(`malware scanner failed${result ? `: ${result}` : ''}`))
          } else {
            resolve({
              clean: code === 0,
              engine: `clamav:${executable}`,
              ...(code === 1 ? { signature: result || `infected ${contentType} content` } : {}),
            })
          }
        })
        child.stdin.end(bytes)
      })
    },
  }
}

/** Content-addressed local storage; called only after a clean malware result. */
export function createContentAddressedEvidenceStorage(rootDirectory: string): EvidenceStorage {
  const root = path.resolve(rootDirectory)
  if (!rootDirectory.trim()) throw new Error('evidence storage directory is required')
  return {
    async put({ bytes, sha256 }) {
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('evidence digest is invalid')
      const reference = `sha256/${sha256.slice(0, 2)}/${sha256}`
      const destination = path.join(root, reference)
      if (!destination.startsWith(`${root}${path.sep}`)) throw new Error('evidence storage path escaped its root')
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      try {
        await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
      return reference
    },
  }
}

export function createEvidenceRuntimeFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const directory = environment.ANCHOR_EVIDENCE_STORAGE_DIRECTORY
  if (!directory) throw new Error('ANCHOR_EVIDENCE_STORAGE_DIRECTORY is required for evidence uploads')
  return {
    evidenceScanner: createClamAvScanner(environment.ANCHOR_EVIDENCE_SCANNER_EXECUTABLE || 'clamscan'),
    evidenceStorage: createContentAddressedEvidenceStorage(directory),
  }
}
