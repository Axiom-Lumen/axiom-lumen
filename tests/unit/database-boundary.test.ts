import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

describe('database architecture boundary', () => {
  it('keeps migration execution out of the Next.js application tree', () => {
    const applicationSource = sourceFiles(join(process.cwd(), 'app'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')

    expect(applicationSource).not.toMatch(/drizzle-kit|node-postgres\/migrator|db:migrate/)
  })
})
