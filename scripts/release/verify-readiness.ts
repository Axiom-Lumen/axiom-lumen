import {
  evaluateProductionReadiness,
  loadProductionReadinessRecord,
  PRODUCTION_READINESS_RECORD_PATH,
} from '../../lib/release/readiness'

const record = loadProductionReadinessRecord(process.argv[2] ?? PRODUCTION_READINESS_RECORD_PATH)
const evaluation = evaluateProductionReadiness(record)
process.stdout.write(`${JSON.stringify({
  public_v1_declared: evaluation.public_v1_declared,
  ready: evaluation.ready,
  blockers: evaluation.blockers,
})}\n`)
if (evaluation.public_v1_declared && !evaluation.ready) {
  throw new Error('public v1 is declared while production-readiness sign-offs remain unsigned')
}
