import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOpenApiDocument } from '../lib/openapi/document'

const outputPath = resolve(process.cwd(), 'openapi/openapi.json')
const generated = `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`

if (process.argv.includes('--write')) {
  writeFileSync(outputPath, generated, 'utf8')
  process.stdout.write(`Wrote ${outputPath}\n`)
} else {
  let committed: string
  try {
    committed = readFileSync(outputPath, 'utf8')
  } catch {
    throw new Error('OpenAPI artifact is missing; run npm run openapi:generate')
  }
  if (committed !== generated) {
    throw new Error('OpenAPI artifact is stale; run npm run openapi:generate and commit the result')
  }
  process.stdout.write('OpenAPI artifact matches runtime contracts\n')
}
