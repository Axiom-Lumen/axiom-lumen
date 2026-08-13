import { releaseSmokeInputFromEnvironment, runReleaseSmoke } from '../../lib/release/smoke'

process.stdout.write(`${JSON.stringify(await runReleaseSmoke(releaseSmokeInputFromEnvironment()))}\n`)
