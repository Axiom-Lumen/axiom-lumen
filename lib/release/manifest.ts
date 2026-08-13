import { createHash } from 'node:crypto'
import { z } from 'zod'

export const releaseManifestSchema = z.object({
  schema_version: z.literal('axiom-release-v1'),
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
  image: z.string().regex(/^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$/),
  image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  source_repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  source_run_id: z.string().regex(/^\d+$/),
  built_at: z.string().datetime({ offset: true }),
  sbom_attested: z.literal(true),
  provenance_attested: z.literal(true),
  ci_passed: z.literal(true),
}).strict().superRefine((manifest, context) => {
  if (!manifest.image.endsWith(`@${manifest.image_digest}`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['image'], message: 'image must be pinned to image_digest' })
  }
})

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>

export function parseReleaseManifest(input: unknown) {
  return releaseManifestSchema.parse(input)
}

export function releaseName(manifest: ReleaseManifest) {
  return `release-${manifest.image_digest.slice('sha256:'.length, 'sha256:'.length + 12)}`
}

export function releaseManifestSha256(manifest: ReleaseManifest) {
  return createHash('sha256').update(JSON.stringify(releaseManifestSchema.parse(manifest))).digest('hex')
}

export interface ReleaseManifestExpectations {
  commitSha?: string
  sourceRepository?: string
  sourceRunId?: string
  imageRepository?: string
}

export function verifyReleaseManifestTrust(
  manifestInput: unknown,
  expectations: ReleaseManifestExpectations,
) {
  const manifest = parseReleaseManifest(manifestInput)
  if (expectations.commitSha && manifest.commit_sha !== expectations.commitSha) {
    throw new Error('release manifest commit does not match the requested commit')
  }
  if (expectations.sourceRepository && manifest.source_repository !== expectations.sourceRepository) {
    throw new Error('release manifest repository does not match the trusted repository')
  }
  if (expectations.sourceRunId && manifest.source_run_id !== expectations.sourceRunId) {
    throw new Error('release manifest run ID does not match the requested build run')
  }
  if (expectations.imageRepository && manifest.image !== `${expectations.imageRepository}@${manifest.image_digest}`) {
    throw new Error('release manifest image does not match the trusted registry repository')
  }
  return manifest
}

export const promotableEnvironmentSchema = z.enum(['preview', 'staging', 'production'])
