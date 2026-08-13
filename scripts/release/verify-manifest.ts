import { readFileSync } from 'node:fs'
import { releaseManifestSha256, verifyReleaseManifestTrust } from '../../lib/release/manifest'

const path = process.argv[2]
if (!path) throw new Error('Usage: verify-manifest <path>')
const manifest = verifyReleaseManifestTrust(JSON.parse(readFileSync(path, 'utf8')), {
  commitSha: process.env.EXPECTED_RELEASE_COMMIT,
  sourceRepository: process.env.EXPECTED_RELEASE_REPOSITORY,
  sourceRunId: process.env.EXPECTED_RELEASE_RUN_ID,
  imageRepository: process.env.EXPECTED_RELEASE_IMAGE_REPOSITORY,
})
process.stdout.write(`${JSON.stringify({
  image: manifest.image,
  image_digest: manifest.image_digest,
  commit_sha: manifest.commit_sha,
  manifest_sha256: releaseManifestSha256(manifest),
})}\n`)
