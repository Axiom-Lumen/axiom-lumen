import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { METHODOLOGY_VERSION } from '../../config/methodology'

const root = fileURLToPath(new URL('../..', import.meta.url))

function listFiles(directory: string, extension: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => relative(root, join(directory, entry.name)))
    .sort()
}

function listFixtureFiles(directory: string): string[] {
  const absolute = join(root, directory)
  const entries = readdirSync(absolute, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const relativePath = join(directory, entry.name)
    if (entry.isDirectory()) return listFixtureFiles(relativePath)
    if (entry.isFile()) return [relativePath]
    return []
  }).sort()
}

const report = {
  generated_at: new Date().toISOString(),
  methodology_version: METHODOLOGY_VERSION,
  configuration_tests: [
    'tests/unit/methodology-config.test.ts',
    'tests/quality/methodology-replay.test.ts',
  ],
  replay_fixtures: listFiles('tests/fixtures/replay', '.json'),
  connector_fixture_files: listFixtureFiles('tests/fixtures'),
  changelog: readFileSync(join(root, 'docs/methodology/changelog.md'), 'utf8').split('\n').slice(0, 12),
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
