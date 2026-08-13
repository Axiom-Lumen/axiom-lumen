import { writeFileSync } from 'node:fs'
import {
  acceptReadinessSignOff,
  loadProductionReadinessRecord,
  PRODUCTION_READINESS_RECORD_PATH,
  PRODUCTION_READINESS_SIGN_OFF_IDS,
  type ProductionReadinessSignOffId,
} from '../../lib/release/readiness'

function readArg(flag: string) {
  const index = process.argv.indexOf(flag)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

const id = readArg('--id') as ProductionReadinessSignOffId
if (!PRODUCTION_READINESS_SIGN_OFF_IDS.includes(id)) {
  throw new Error(`--id must be one of ${PRODUCTION_READINESS_SIGN_OFF_IDS.join(', ')}`)
}

const recordPath = process.argv.includes('--record')
  ? readArg('--record')
  : PRODUCTION_READINESS_RECORD_PATH

const updated = acceptReadinessSignOff(loadProductionReadinessRecord(recordPath), {
  id,
  reviewer: readArg('--reviewer'),
  evidenceRef: readArg('--evidence-ref'),
  recordedAt: process.argv.includes('--recorded-at') ? readArg('--recorded-at') : undefined,
  notes: process.argv.includes('--notes') ? readArg('--notes') : undefined,
})

writeFileSync(recordPath, `${JSON.stringify(updated, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ status: 'recorded', id, record_path: recordPath })}\n`)
