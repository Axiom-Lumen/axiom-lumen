# OpenAPI contract

The production OpenAPI 3.1 document is [`openapi/openapi.json`](../openapi/openapi.json). It contains only the
implemented public operations:

- `GET` and `OPTIONS /api/v1/stellar/latest-ledger`
- `GET` and `OPTIONS /api/v1/supply/{asset}`
- `GET` and `OPTIONS /api/v1/depth/{pair}`

Planned trustline, anchor, authentication, quota, and event endpoints are excluded. Authentication and
rate-limit failures are retained as unreferenced reusable response components for the future policies that
introduce those responses; their presence does not claim that current public operations enforce authentication
or quotas.

## Source and generation

[`lib/openapi/document.ts`](../lib/openapi/document.ts) converts the shared Zod response schemas into OpenAPI
components and adds the HTTP behavior approved in ADR 0006. Examples are parsed by the same runtime schemas
before document generation.

After changing a public route, response schema, example, status, parameter, or response header, regenerate:

```bash
npm run openapi:generate
```

Then verify the committed artifact:

```bash
npm run openapi:check
```

The check performs a byte-for-byte comparison against deterministic generation. Unit tests also validate the
document as OpenAPI 3.1, parse every example through its runtime schema, and limit production paths and methods
to the explicit implemented-operation manifest. Integration tests dereference the generated document and
validate actual GET and OPTIONS response bodies, statuses, and documented headers against it. CI runs the drift
check before the test suites.

## Compatibility rule

Do not edit `openapi/openapi.json` by hand. Update the runtime schema or document generator, regenerate, and
review both the source change and generated diff. API-03 does not replace the compatibility process described in
the domain/API contract: removing fields, changing types, or narrowing accepted values still requires an explicit
versioning decision.
