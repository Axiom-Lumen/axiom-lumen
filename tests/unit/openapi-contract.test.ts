import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import SwaggerParser from '@apidevtools/swagger-parser'
import { describe, expect, it } from 'vitest'
import { apiErrorResponseSchema, apiReconciliationSnapshotSchema } from '../../lib/contracts'
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
    const errorExamples = [
      OPENAPI_EXAMPLES.invalidRequestId,
      OPENAPI_EXAMPLES.invalidQueryParameter,
      OPENAPI_EXAMPLES.invalidAsset,
      OPENAPI_EXAMPLES.invalidPair,
      OPENAPI_EXAMPLES.latestMissingSnapshot,
      OPENAPI_EXAMPLES.supplyMissingSnapshot,
      OPENAPI_EXAMPLES.depthMissingSnapshot,
      OPENAPI_EXAMPLES.latestReadUnavailable,
      OPENAPI_EXAMPLES.supplyReadUnavailable,
      OPENAPI_EXAMPLES.depthReadUnavailable,
      OPENAPI_EXAMPLES.authenticationError,
      OPENAPI_EXAMPLES.rateLimitError,
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

  it('matches the committed generated artifact byte for byte', () => {
    const committed = readFileSync(resolve(process.cwd(), 'openapi/openapi.json'), 'utf8')
    expect(committed).toBe(`${JSON.stringify(createOpenApiDocument(), null, 2)}\n`)
  })
})
