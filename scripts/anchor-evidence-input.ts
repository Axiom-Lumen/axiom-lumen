import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { MAXIMUM_EVIDENCE_BYTES, type EvidenceSubmission } from '../lib/anchor/claims'

const CONTENT_TYPES = new Map([
  ['.pdf', 'application/pdf'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'], ['.txt', 'text/plain'],
])

export async function evidenceFromArguments(arguments_: readonly string[]): Promise<EvidenceSubmission[]> {
  const evidence: EvidenceSubmission[] = []
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === '--link') {
      const url = arguments_[index + 1]
      if (!url) throw new Error('--link requires a URL')
      evidence.push({ kind: 'link', url })
      index += 1
    } else if (arguments_[index] === '--upload') {
      const filename = arguments_[index + 1]
      if (!filename) throw new Error('--upload requires a file path')
      const contentType = CONTENT_TYPES.get(path.extname(filename).toLowerCase())
      if (!contentType) throw new Error('--upload supports .pdf, .jpg, .jpeg, .png, and .txt files')
      const details = await stat(filename)
      if (!details.isFile() || details.size === 0 || details.size > MAXIMUM_EVIDENCE_BYTES) {
        throw new Error(`evidence upload must contain 1 through ${MAXIMUM_EVIDENCE_BYTES} bytes`)
      }
      evidence.push({ kind: 'upload', bytes: await readFile(filename), contentType })
      index += 1
    }
  }
  return evidence
}
