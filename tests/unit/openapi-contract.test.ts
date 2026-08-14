import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import SwaggerParser from '@apidevtools/swagger-parser'
import { describe, expect, it } from 'vitest'
import { apiErrorResponseSchema, apiReconciliationSnapshotSchema, apiSnapshotEventSchema } from '../../lib/contracts'
import {
  IMPLEMENTED_PUBLIC_OPERATIONS,
  OPENAPI_EXAMPLES,
  createOpenApiDocument,
} from '../../lib/openapi/document'
import { latestLedgerResponseSchema } from '../../lib/reconcile/latest-ledger'

describe('OpenAPI 3.1 contract', () => {
  it('is a valid OpenAPI document containing implemented production routes only', async () => {
    const document = createOpenApiDocument()
    await expect(SwaggerParser.validate(structuredClone(document) as never)).resolves.toBeDefined()
    expect(document.openapi).toBe('3.1.0')
    expect(Object.keys(document.paths).sort()).toEqual(
      [...new Set(IMPLEMENTED_PUBLIC_OPERATIONS.map((operation) => operation.path))].sort(),
    )
  })

  it('keeps every generated response example valid against its runtime schema', () => {
    expect(latestLedgerResponseSchema.parse(OPENAPI_EXAMPLES.latestVerified)).toEqual(OPENAPI_EXAMPLES.latestVerified)
    expect(latestLedgerResponseSchema.parse(OPENAPI_EXAMPLES.latestDegraded)).toEqual(OPENAPI_EXAMPLES.latestDegraded)
    expect(latestLedgerResponseSchema.parse(OPENAPI_EXAMPLES.latestUnavailable)).toEqual(OPENAPI_EXAMPLES.latestUnavailable)
    expect(apiReconciliationSnapshotSchema.parse(OPENAPI_EXAMPLES.supplyVerified)).toEqual(OPENAPI_EXAMPLES.supplyVerified)
    expect(apiReconciliationSnapshotSchema.parse(OPENAPI_EXAMPLES.supplyDegraded)).toEqual(OPENAPI_EXAMPLES.supplyDegraded)
    expect(apiReconciliationSnapshotSchema.parse(OPENAPI_EXAMPLES.supplyUnavailable)).toEqual(OPENAPI_EXAMPLES.supplyUnavailable)
    expect(apiReconciliationSnapshotSchema.parse(OPENAPI_EXAMPLES.depthVerified)).toEqual(OPENAPI_EXAMPLES.depthVerified)
    expect(apiReconciliationSnapshotSchema.parse(OPENAPI_EXAMPLES.depthDegraded)).toEqual(OPENAPI_EXAMPLES.depthDegraded)
    expect(apiReconciliationSnapshotSchema.parse(OPENAPI_EXAMPLES.depthUnavailable)).toEqual(OPENAPI_EXAMPLES.depthUnavailable)
    expect(apiReconciliationSnapshotSchema.parse(OPENAPI_EXAMPLES.trustlineVerified)).toEqual(OPENAPI_EXAMPLES.trustlineVerified)
    expect(apiReconciliationSnapshotSchema.parse(OPENAPI_EXAMPLES.trustlineDegraded)).toEqual(OPENAPI_EXAMPLES.trustlineDegraded)
    expect(apiReconciliationSnapshotSchema.parse(OPENAPI_EXAMPLES.trustlineUnavailable)).toEqual(OPENAPI_EXAMPLES.trustlineUnavailable)
    expect(apiSnapshotEventSchema.parse(OPENAPI_EXAMPLES.snapshotEvent)).toEqual(OPENAPI_EXAMPLES.snapshotEvent)
    const errorExamples = [
      OPENAPI_EXAMPLES.invalidRequestId,
      OPENAPI_EXAMPLES.invalidQueryParameter,
      OPENAPI_EXAMPLES.invalidAsset,
      OPENAPI_EXAMPLES.invalidPair,
      OPENAPI_EXAMPLES.latestMissingSnapshot,
      OPENAPI_EXAMPLES.supplyMissingSnapshot,
      OPENAPI_EXAMPLES.depthMissingSnapshot,
      OPENAPI_EXAMPLES.trustlineMissingSnapshot,
      OPENAPI_EXAMPLES.latestReadUnavailable,
      OPENAPI_EXAMPLES.supplyReadUnavailable,
      OPENAPI_EXAMPLES.depthReadUnavailable,
      OPENAPI_EXAMPLES.trustlineReadUnavailable,
      OPENAPI_EXAMPLES.authenticationError,
      OPENAPI_EXAMPLES.insufficientScope,
      OPENAPI_EXAMPLES.rateLimitError,
      OPENAPI_EXAMPLES.invalidLastEventId,
      OPENAPI_EXAMPLES.replayWindowExceeded,
      OPENAPI_EXAMPLES.streamUnavailable,
    ]
    for (const example of errorExamples) {
      expect(apiErrorResponseSchema.parse(example)).toEqual(example)
    }
  })

  it('tracks every implemented method and operation identifier', () => {
    const document = createOpenApiDocument()
    for (const operation of IMPLEMENTED_PUBLIC_OPERATIONS) {
      const pathDocument = document.paths[operation.path]
      expect(pathDocument[operation.method].operationId).toBe(operation.operationId)
    }
  })

  it('requires hosted API-key security and documents quota metadata on application responses', () => {
    const document = createOpenApiDocument()
    for (const operation of IMPLEMENTED_PUBLIC_OPERATIONS.filter((item) => item.method === 'get')) {
      const contract = document.paths[operation.path].get!
      expect(contract.security).toEqual([{ ApiKeyAuth: [] }])
      for (const status of ['200', '304', '400', '404', '503']) {
        const response = contract.responses[status as keyof typeof contract.responses]
        if (!response || !('headers' in response)) continue
        expect(response.headers).toHaveProperty('X-RateLimit-Limit')
        expect(response.headers).toHaveProperty('X-RateLimit-Remaining')
        expect(response.headers).toHaveProperty('X-RateLimit-Reset')
      }
    }
  })

  it('matches the committed generated artifact byte for byte', () => {
    const committed = readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8')
    expect(committed).toBe(`${JSON.stringify(createOpenApiDocument(), null, 2)}\n`)
  })
})
