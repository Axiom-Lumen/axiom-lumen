import { createHash } from 'node:crypto'

export function canonicalEvidenceJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON evidence contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalEvidenceJson).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalEvidenceJson(nested)}`)
      .join(',')}}`
  }
  throw new Error(`JSON evidence contains unsupported ${typeof value} value`)
}

export function computeEvidenceSha256(value: unknown) {
  return createHash('sha256').update(canonicalEvidenceJson(value)).digest('hex')
}
