import { z } from 'zod'

export const RELEASE_ENVIRONMENTS = ['development', 'preview', 'staging', 'production'] as const
export type ReleaseEnvironment = (typeof RELEASE_ENVIRONMENTS)[number]

const booleanValue = z.enum(['true', 'false']).transform((value) => value === 'true')
const imageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const commitSha = z.string().regex(/^[0-9a-f]{40}$/)
export const releaseExecutionIdSchema = z.string().min(1).max(24).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)

export interface ReleaseFeatureFlags {
  supply: boolean
  depth: boolean
  trustlines: boolean
  anchorReserves: boolean
  namedPartyPublication: boolean
}

function flag(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: boolean,
) {
  const value = environment[name]
  return value === undefined ? fallback : booleanValue.parse(value)
}

export function parseReleaseFeatureFlags(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReleaseFeatureFlags {
  return Object.freeze({
    supply: flag(environment, 'AXIOM_FEATURE_SUPPLY_ENABLED', true),
    depth: flag(environment, 'AXIOM_FEATURE_DEPTH_ENABLED', true),
    trustlines: flag(environment, 'AXIOM_FEATURE_TRUSTLINES_ENABLED', true),
    anchorReserves: flag(environment, 'AXIOM_FEATURE_ANCHOR_RESERVES_ENABLED', true),
    namedPartyPublication: flag(environment, 'ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED', false),
  })
}

export const releaseMetadataSchema = z.object({
  environment: z.enum(RELEASE_ENVIRONMENTS),
  imageDigest,
  commitSha,
}).strict()

export function parseReleaseMetadata(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const candidate = {
    environment: environment.AXIOM_RELEASE_ENVIRONMENT,
    imageDigest: environment.AXIOM_RELEASE_IMAGE_DIGEST,
    commitSha: environment.AXIOM_RELEASE_COMMIT_SHA,
  }
  const parsed = releaseMetadataSchema.safeParse(candidate)
  if (parsed.success) return parsed.data
  if (environment.NODE_ENV === 'production') {
    throw new Error('production release metadata must include environment, image digest, and commit SHA')
  }
  return null
}

export function releaseNamespace(environment: Exclude<ReleaseEnvironment, 'development'>) {
  return `axiom-${environment}`
}
