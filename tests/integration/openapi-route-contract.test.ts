import { describe, it } from 'vitest'
import {
  GET as latestLedgerGet,
  OPTIONS as latestLedgerOptions,
} from '../../app/api/v1/stellar/latest-ledger/route'
import {
  GET as supplyGet,
  OPTIONS as supplyOptions,
} from '../../app/api/v1/supply/[asset]/route'
import { IMPLEMENTED_PUBLIC_OPERATIONS } from '../../lib/openapi/document'
import { expectOpenApiResponse } from '../helpers/openapi-response'

const ISSUER = `G${'A'.repeat(55)}`
const ASSET = `USDC:${ISSUER}`
type OperationId = (typeof IMPLEMENTED_PUBLIC_OPERATIONS)[number]['operationId']

const contractRequests: Record<OperationId, () => Response | Promise<Response>> = {
  getLatestLedger: () => latestLedgerGet(new Request('https://axiom.example/api/v1/stellar/latest-ledger', {
    headers: { 'X-Request-ID': 'invalid request id' },
  })),
  latestLedgerOptions: () => latestLedgerOptions(new Request('https://axiom.example/api/v1/stellar/latest-ledger', {
    method: 'OPTIONS',
    headers: { 'X-Request-ID': 'contract_latest_options' },
  })),
  getSupply: () => supplyGet(new Request(`https://axiom.example/api/v1/supply/${ASSET}`, {
    headers: { 'X-Request-ID': 'invalid request id' },
  }), { params: Promise.resolve({ asset: ASSET }) }),
  supplyOptions: () => supplyOptions(new Request(`https://axiom.example/api/v1/supply/${ASSET}`, {
    method: 'OPTIONS',
    headers: { 'X-Request-ID': 'contract_supply_options' },
  })),
}

describe('implemented OpenAPI operation coverage', () => {
  for (const operation of IMPLEMENTED_PUBLIC_OPERATIONS) {
    it(`validates an actual ${operation.method.toUpperCase()} ${operation.path} response`, async () => {
      const response = await contractRequests[operation.operationId]()
      await expectOpenApiResponse(response, operation.path, operation.method)
    })
  }
})
