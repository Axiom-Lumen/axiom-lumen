import { parseReleaseFeatureFlags, releaseExecutionIdSchema, releaseNamespace, type ReleaseEnvironment } from './config'
import { parseReleaseManifest, releaseName, type ReleaseManifest } from './manifest'

export type ReleasePhase = 'preflight' | 'migration' | 'runtime'

interface KubernetesReleaseInput {
  environment: Exclude<ReleaseEnvironment, 'development'>
  manifest: ReleaseManifest
  phase: ReleasePhase
  executionId: string
  features: ReturnType<typeof parseReleaseFeatureFlags>
}

const RELEASE_CONFIG_KEYS = [
  'AXIOM_API_AUTH_REQUIRED',
  'AXIOM_RELEASE_ENVIRONMENT',
  'AXIOM_RELEASE_IMAGE_DIGEST',
  'AXIOM_RELEASE_COMMIT_SHA',
  'AXIOM_FEATURE_SUPPLY_ENABLED',
  'AXIOM_FEATURE_DEPTH_ENABLED',
  'AXIOM_FEATURE_TRUSTLINES_ENABLED',
  'AXIOM_FEATURE_ANCHOR_RESERVES_ENABLED',
  'ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED',
] as const

function labels(manifest: ReleaseManifest) {
  return {
    app: 'axiom-lumen',
    'app.kubernetes.io/name': 'axiom-lumen',
    'app.kubernetes.io/version': manifest.commit_sha.slice(0, 12),
    'axiom.dev/release': releaseName(manifest),
  }
}

function restrictedContainer(name: string, image: string, args: string[], envFrom: string[], ports?: unknown[]) {
  return {
    name,
    image,
    imagePullPolicy: 'IfNotPresent',
    args,
    envFrom: envFrom.map((secretName) => ({ secretRef: { name: secretName } })),
    ...(ports ? { ports } : {}),
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 10001,
    },
    resources: {
      requests: { cpu: '100m', memory: '256Mi' },
      limits: { cpu: '1', memory: '1Gi' },
    },
  }
}

function job(input: KubernetesReleaseInput, purpose: 'preflight' | 'migration') {
  const name = `${releaseName(input.manifest)}-${purpose}-${releaseExecutionIdSchema.parse(input.executionId)}`
  const container = restrictedContainer(
    purpose,
    input.manifest.image,
    [purpose === 'preflight' ? 'backup-check' : 'migrate'],
    [purpose === 'preflight' ? 'axiom-backup-env' : 'axiom-migration-env'],
  )
  if (purpose === 'preflight') {
    ;(container as Record<string, unknown>).volumeMounts = [{ name: 'backups', mountPath: '/var/backups/axiom-lumen', readOnly: true }]
  }
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: releaseNamespace(input.environment),
      labels: { ...labels(input.manifest), 'axiom.dev/execution': input.executionId },
    },
    spec: {
      activeDeadlineSeconds: 600,
      backoffLimit: 0,
      ttlSecondsAfterFinished: 86_400,
      template: {
        metadata: { labels: labels(input.manifest) },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [container],
          ...(purpose === 'preflight'
            ? { volumes: [{ name: 'backups', persistentVolumeClaim: { claimName: 'axiom-backups' } }] }
            : {}),
        },
      },
    },
  }
}

function configMap(input: KubernetesReleaseInput) {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'axiom-release', namespace: releaseNamespace(input.environment), labels: labels(input.manifest) },
    data: {
      AXIOM_API_AUTH_REQUIRED: 'true',
      AXIOM_RELEASE_ENVIRONMENT: input.environment,
      AXIOM_RELEASE_IMAGE_DIGEST: input.manifest.image_digest,
      AXIOM_RELEASE_COMMIT_SHA: input.manifest.commit_sha,
      AXIOM_FEATURE_SUPPLY_ENABLED: String(input.features.supply),
      AXIOM_FEATURE_DEPTH_ENABLED: String(input.features.depth),
      AXIOM_FEATURE_TRUSTLINES_ENABLED: String(input.features.trustlines),
      AXIOM_FEATURE_ANCHOR_RESERVES_ENABLED: String(input.features.anchorReserves),
      ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED: String(input.features.namedPartyPublication),
    },
  }
}

function deployment(input: KubernetesReleaseInput, role: 'web' | 'worker') {
  const name = `axiom-${role}`
  const container = restrictedContainer(
    role,
    input.manifest.image,
    [role],
    ['axiom-runtime-env'],
    role === 'web' ? [{ name: 'http', containerPort: 3000 }] : undefined,
  ) as Record<string, unknown>
  container.env = RELEASE_CONFIG_KEYS.map((name) => ({
    name,
    valueFrom: { configMapKeyRef: { name: 'axiom-release', key: name } },
  }))
  if (role === 'web') {
    container.livenessProbe = { httpGet: { path: '/api/health/live', port: 'http' }, periodSeconds: 15 }
    container.readinessProbe = { httpGet: { path: '/api/health/ready', port: 'http' }, periodSeconds: 10 }
  }
  container.volumeMounts = role === 'web'
    ? [{ name: 'next-cache', mountPath: '/app/.next/cache' }, { name: 'tmp', mountPath: '/tmp' }]
    : [{ name: 'tmp', mountPath: '/tmp' }]
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: releaseNamespace(input.environment), labels: labels(input.manifest) },
    spec: {
      replicas: role === 'web' && input.environment === 'production' ? 2 : 1,
      revisionHistoryLimit: 5,
      strategy: role === 'web'
        ? { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }
        : { type: 'Recreate' },
      selector: { matchLabels: { app: 'axiom-lumen', role } },
      template: {
        metadata: { labels: { ...labels(input.manifest), role } },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
          terminationGracePeriodSeconds: role === 'worker' ? 60 : 30,
          containers: [container],
          volumes: [
            { name: 'tmp', emptyDir: {} },
            ...(role === 'web' ? [{ name: 'next-cache', emptyDir: {} }] : []),
          ],
        },
      },
    },
  }
}

function service(input: KubernetesReleaseInput) {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'axiom-web', namespace: releaseNamespace(input.environment), labels: labels(input.manifest) },
    spec: { selector: { app: 'axiom-lumen', role: 'web' }, ports: [{ name: 'http', port: 80, targetPort: 'http' }] },
  }
}

function backupCronJob(input: KubernetesReleaseInput, checkOnly: boolean) {
  const name = checkOnly ? 'axiom-backup-check' : 'axiom-backup'
  const container = restrictedContainer(name, input.manifest.image, [checkOnly ? 'backup-check' : 'backup'], ['axiom-backup-env']) as Record<string, unknown>
  container.volumeMounts = [
    { name: 'backups', mountPath: '/var/backups/axiom-lumen', ...(checkOnly ? { readOnly: true } : {}) },
    { name: 'tmp', mountPath: '/tmp' },
  ]
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: { name, namespace: releaseNamespace(input.environment), labels: labels(input.manifest) },
    spec: {
      schedule: checkOnly ? '7 * * * *' : '23 2 * * *',
      concurrencyPolicy: 'Forbid',
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 5,
      jobTemplate: {
        spec: {
          backoffLimit: 1,
          template: {
            metadata: { labels: { ...labels(input.manifest), role: name } },
            spec: {
              restartPolicy: 'Never',
              automountServiceAccountToken: false,
              securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
              containers: [container],
              volumes: [
                { name: 'backups', persistentVolumeClaim: { claimName: 'axiom-backups' } },
                { name: 'tmp', emptyDir: {} },
              ],
            },
          },
        },
      },
    },
  }
}

export function renderKubernetesRelease(input: KubernetesReleaseInput) {
  const parsed: KubernetesReleaseInput = {
    ...input,
    manifest: parseReleaseManifest(input.manifest),
  }
  const items = parsed.phase === 'preflight'
    ? [job(parsed, 'preflight')]
    : parsed.phase === 'migration'
      ? [job(parsed, 'migration')]
      : [
          configMap(parsed),
          deployment(parsed, 'web'),
          deployment(parsed, 'worker'),
          service(parsed),
          ...(parsed.environment === 'production'
            ? [backupCronJob(parsed, false), backupCronJob(parsed, true)]
            : []),
        ]
  return { apiVersion: 'v1', kind: 'List', items }
}
