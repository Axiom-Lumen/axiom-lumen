import { readFileSync } from 'node:fs'
import { promotableEnvironmentSchema, parseReleaseManifest } from '../../lib/release/manifest'
import { renderKubernetesRelease, type ReleasePhase } from '../../lib/release/kubernetes'
import { parseReleaseFeatureFlags } from '../../lib/release/config'

const manifestPath = process.env.RELEASE_MANIFEST_PATH
const executionId = process.env.RELEASE_EXECUTION_ID
const phase = process.env.RELEASE_PHASE as ReleasePhase | undefined
if (!manifestPath || !executionId || !phase || !['preflight', 'migration', 'runtime'].includes(phase)) {
  throw new Error('RELEASE_MANIFEST_PATH, RELEASE_EXECUTION_ID, and RELEASE_PHASE are required')
}
const environment = promotableEnvironmentSchema.parse(process.env.RELEASE_ENVIRONMENT)
const manifest = parseReleaseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
process.stdout.write(`${JSON.stringify(renderKubernetesRelease({
  environment,
  manifest,
  phase,
  executionId,
  features: parseReleaseFeatureFlags(),
}))}\n`)
