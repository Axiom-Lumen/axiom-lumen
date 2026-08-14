import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseReleaseFeatureFlags, parseReleaseMetadata, releaseNamespace } from '../../lib/release/config'
import { renderKubernetesRelease } from '../../lib/release/kubernetes'
import { parseReleaseManifest, releaseManifestSha256, releaseName, verifyReleaseManifestTrust } from '../../lib/release/manifest'

const digest = `sha256:${'a'.repeat(64)}`
const manifest = parseReleaseManifest({
  schema_version: 'axiom-release-v1',
  commit_sha: 'b'.repeat(40),
  image: `ghcr.io/axiom-lumen/axiom-lumen@${digest}`,
  image_digest: digest,
  source_repository: 'axiom-lumen/axiom-lumen',
  source_run_id: '12345',
  built_at: '2026-08-13T12:00:00.000Z',
  sbom_attested: true,
  provenance_attested: true,
  ci_passed: true,
})

describe('release automation', () => {
  it('validates fail-closed feature flags and immutable runtime metadata', () => {
    expect(parseReleaseFeatureFlags({
      AXIOM_FEATURE_SUPPLY_ENABLED: 'false',
      ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED: 'true',
    })).toMatchObject({ supply: false, depth: true, namedPartyPublication: true })
    expect(() => parseReleaseFeatureFlags({ AXIOM_FEATURE_DEPTH_ENABLED: 'yes' })).toThrow()
    expect(parseReleaseMetadata({
      NODE_ENV: 'production',
      AXIOM_RELEASE_ENVIRONMENT: 'staging',
      AXIOM_RELEASE_IMAGE_DIGEST: digest,
      AXIOM_RELEASE_COMMIT_SHA: 'b'.repeat(40),
    })).toEqual({ environment: 'staging', imageDigest: digest, commitSha: 'b'.repeat(40) })
    expect(() => parseReleaseMetadata({ NODE_ENV: 'production' })).toThrow(/release metadata/)
    expect(releaseNamespace('production')).toBe('axiom-production')
  })

  it('rejects mutable or inconsistent release manifests', () => {
    expect(releaseName(manifest)).toBe('release-aaaaaaaaaaaa')
    expect(releaseManifestSha256(manifest)).toMatch(/^[0-9a-f]{64}$/)
    expect(() => parseReleaseManifest({ ...manifest, image: 'ghcr.io/axiom/app:latest' })).toThrow()
    expect(() => parseReleaseManifest({ ...manifest, image_digest: `sha256:${'c'.repeat(64)}` })).toThrow(/pinned/)
  })

  it('binds a release manifest to the trusted commit, run, repository, and registry path', () => {
    expect(verifyReleaseManifestTrust(manifest, {
      commitSha: manifest.commit_sha,
      sourceRepository: manifest.source_repository,
      sourceRunId: manifest.source_run_id,
      imageRepository: 'ghcr.io/axiom-lumen/axiom-lumen',
    })).toEqual(manifest)
    expect(() => verifyReleaseManifestTrust(manifest, { sourceRunId: '999' })).toThrow(/run ID/)
    expect(() => verifyReleaseManifestTrust(manifest, { sourceRepository: 'attacker/repository' })).toThrow(/trusted repository/)
    expect(() => verifyReleaseManifestTrust(manifest, { imageRepository: 'ghcr.io/attacker/image' })).toThrow(/trusted registry/)
  })

  it('pins migration, web, worker, and production backup units to one image digest', () => {
    const features = parseReleaseFeatureFlags({
      AXIOM_FEATURE_SUPPLY_ENABLED: 'true', AXIOM_FEATURE_DEPTH_ENABLED: 'false',
      AXIOM_FEATURE_TRUSTLINES_ENABLED: 'true', AXIOM_FEATURE_ANCHOR_RESERVES_ENABLED: 'false',
      ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED: 'false',
    })
    const migration = renderKubernetesRelease({ environment: 'production', manifest, phase: 'migration', executionId: '12345-1', features })
    const runtime = renderKubernetesRelease({ environment: 'production', manifest, phase: 'runtime', executionId: '12345-1', features })
    expect(migration.items).toHaveLength(1)
    expect(migration.items[0]).toMatchObject({
      metadata: { name: 'release-aaaaaaaaaaaa-migration-12345-1' },
      spec: { activeDeadlineSeconds: 600, backoffLimit: 0 },
    })
    expect(JSON.stringify(migration)).toContain(manifest.image)
    expect(runtime.items.map((item) => item.kind)).toEqual([
      'ConfigMap', 'Deployment', 'Deployment', 'Service', 'CronJob', 'CronJob',
    ])
    expect(JSON.stringify(runtime)).not.toContain(':latest')
    expect(JSON.stringify(runtime).match(new RegExp(manifest.image_digest, 'g'))?.length).toBeGreaterThanOrEqual(5)
    expect(runtime.items[0]).toMatchObject({
      data: {
        AXIOM_FEATURE_DEPTH_ENABLED: 'false',
        ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED: 'false',
      },
    })
    expect(runtime.items[1]).toMatchObject({
      spec: { template: { spec: { containers: [{
        envFrom: [{ secretRef: { name: 'axiom-runtime-env' } }],
        env: expect.arrayContaining([
          expect.objectContaining({ name: 'AXIOM_API_AUTH_REQUIRED' }),
          expect.objectContaining({ name: 'AXIOM_FEATURE_DEPTH_ENABLED' }),
        ]),
      }] } } },
    })
    expect(runtime.items[2]).toMatchObject({ spec: { strategy: { type: 'Recreate' } } })
  })

  it('keeps preview isolated and excludes production backup schedules', () => {
    const runtime = renderKubernetesRelease({
      environment: 'preview', manifest, phase: 'runtime', executionId: '12345-1', features: parseReleaseFeatureFlags({}),
    })
    expect(runtime.items.every((item) => item.metadata.namespace === 'axiom-preview')).toBe(true)
    expect(runtime.items.some((item) => item.kind === 'CronJob')).toBe(false)
  })

  it('creates a fresh bounded preflight job for every promotion attempt', () => {
    const features = parseReleaseFeatureFlags({})
    const first = renderKubernetesRelease({ environment: 'staging', manifest, phase: 'preflight', executionId: '12345-1', features })
    const retry = renderKubernetesRelease({ environment: 'staging', manifest, phase: 'preflight', executionId: '12345-2', features })
    expect(first.items[0].metadata.name).not.toBe(retry.items[0].metadata.name)
    expect(first.items[0]).toMatchObject({ spec: { activeDeadlineSeconds: 600 } })
  })

  it('defines a single-build promotion and an explicit schema-compatible rollback', () => {
    const build = readFileSync(new URL('../../.github/workflows/release-build.yml', import.meta.url), 'utf8')
    const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const promotion = readFileSync(new URL('../../.github/workflows/release-promote.yml', import.meta.url), 'utf8')
    const rollback = readFileSync(new URL('../../.github/workflows/release-rollback.yml', import.meta.url), 'utf8')
    const imageBuild = build.indexOf('Build and push once')
    const imageAcceptance = build.indexOf('Exercise exact image runtime roles')
    const imageAttestation = build.indexOf('Attest build provenance')
    const releaseManifest = build.indexOf('Create immutable release manifest')
    expect(imageBuild).toBeGreaterThan(-1)
    expect(imageAcceptance).toBeGreaterThan(imageBuild)
    expect(imageAttestation).toBeGreaterThan(imageAcceptance)
    expect(releaseManifest).toBeGreaterThan(imageAttestation)
    expect(build).toContain('bash deploy/verify-release-image.sh')
    expect(promotion).toContain('download-artifact@v4')
    expect(promotion).not.toContain('docker/build-push-action')
    expect(promotion).toContain('Apply forward migrations')
    expect(promotion).toContain('ref: ${{ steps.release.outputs.commit }}')
    expect(promotion).toContain('path: source')
    expect(promotion).toContain('gh attestation verify')
    expect(promotion).toContain('.SBOM.SPDX')
    expect(promotion).toContain('RELEASE_EXECUTION_ID: ${{ github.run_id }}-${{ github.run_attempt }}')
    expect(promotion).toContain('RELEASE_WORKER_PROGRESS_AFTER: ${{ steps.rollout.outputs.worker_progress_after }}')
    expect(promotion).toContain('release:promotion-policy-verify')
    expect(ci).toContain('release:readiness-verify')
    expect(promotion).not.toContain('<<:')
    expect(rollback).toContain('schema_compatible_ack')
    expect(rollback).toContain('release:promotion-policy-verify')
    expect(rollback).toContain('inputs.supply_enabled')
    expect(rollback).toContain('ref: ${{ steps.release.outputs.commit }}')
    expect(rollback).toContain('gh attestation verify')
    expect(rollback).toContain('RELEASE_WORKER_PROGRESS_AFTER: ${{ steps.rollout.outputs.worker_progress_after }}')
    expect(rollback).not.toContain('<<:')
    expect(rollback).not.toContain('db:migrate')
  })
})
