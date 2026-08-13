import {
  assertPromotionPolicy,
  loadProductionReadinessRecord,
  PRODUCTION_READINESS_RECORD_PATH,
} from '../../lib/release/readiness'

function booleanFlag(value: string | undefined, name: string) {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}

const environment = process.env.RELEASE_ENVIRONMENT
if (!environment) throw new Error('RELEASE_ENVIRONMENT is required')

assertPromotionPolicy(loadProductionReadinessRecord(process.argv[2] ?? PRODUCTION_READINESS_RECORD_PATH), {
  environment,
  namedPartyPublicationEnabled: booleanFlag(
    process.env.ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED,
    'ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED',
  ),
})

process.stdout.write(`${JSON.stringify({ status: 'allowed', environment })}\n`)
