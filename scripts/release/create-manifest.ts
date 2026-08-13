import { writeFileSync } from 'node:fs'
import { parseReleaseManifest } from '../../lib/release/manifest'

const outputIndex = process.argv.indexOf('--output')
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined
if (!output) throw new Error('Usage: create-manifest --output <path>')

const manifest = parseReleaseManifest({
  schema_version: 'axiom-release-v1',
  commit_sha: process.env.RELEASE_COMMIT_SHA,
  image: process.env.RELEASE_IMAGE,
  image_digest: process.env.RELEASE_IMAGE_DIGEST,
  source_repository: process.env.GITHUB_REPOSITORY,
  source_run_id: process.env.GITHUB_RUN_ID,
  built_at: new Date().toISOString(),
  sbom_attested: true,
  provenance_attested: true,
  ci_passed: true,
})
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
