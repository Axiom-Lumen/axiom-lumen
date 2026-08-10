import SwaggerParser from '@apidevtools/swagger-parser'
import Ajv2020 from 'ajv/dist/2020'
import { expect } from 'vitest'
import { createOpenApiDocument } from '../../lib/openapi/document'

type PublicMethod = 'get' | 'options'
type JsonSchema = Record<string, unknown>

interface ResponseContent {
  schema: JsonSchema
}

interface ResponseObject {
  headers?: Record<string, { schema: JsonSchema }>
  content?: { 'application/json'?: ResponseContent }
}

interface OperationObject {
  operationId: string
  responses: Record<string, ResponseObject>
}

interface DereferencedDocument {
  paths: Record<string, Partial<Record<PublicMethod, OperationObject>>>
}

const validator = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
let documentPromise: Promise<DereferencedDocument> | undefined

function dereferencedDocument() {
  documentPromise ??= SwaggerParser.dereference(
    structuredClone(createOpenApiDocument()) as never,
  ) as unknown as Promise<DereferencedDocument>
  return documentPromise
}

function validationMessage(errors: unknown) {
  return `OpenAPI response validation failed: ${JSON.stringify(errors, null, 2)}`
}

export async function expectOpenApiResponse(
  response: Response,
  path: string,
  method: PublicMethod,
) {
  const document = await dereferencedDocument()
  const operation = document.paths[path]?.[method]
  expect(operation, `${method.toUpperCase()} ${path} is absent from OpenAPI`).toBeDefined()

  const responseContract = operation?.responses[String(response.status)]
  expect(
    responseContract,
    `${method.toUpperCase()} ${path} does not document status ${response.status}`,
  ).toBeDefined()
  if (!responseContract) return

  for (const [headerName, headerContract] of Object.entries(responseContract.headers ?? {})) {
    const value = response.headers.get(headerName)
    expect(value, `${response.status} ${method.toUpperCase()} ${path} omitted ${headerName}`).not.toBeNull()
    if (value === null) continue

    const validateHeader = validator.compile(headerContract.schema)
    expect(validateHeader(value), validationMessage(validateHeader.errors)).toBe(true)
  }

  const mediaType = responseContract.content?.['application/json']
  if (!mediaType) {
    expect(await response.text()).toBe('')
    return
  }

  expect(response.headers.get('content-type')).toContain('application/json')
  const body = await response.json()
  const validateBody = validator.compile(mediaType.schema)
  expect(validateBody(body), validationMessage(validateBody.errors)).toBe(true)
}
