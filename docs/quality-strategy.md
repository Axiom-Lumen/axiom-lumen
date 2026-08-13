# Quality strategy

Axiom Lumen separates deterministic pull-request checks from environment-dependent smoke and recovery checks.
The ordinary CI path never requires a live Stellar endpoint. All clocks, random values, IDs, network responses,
and failure decisions used by its tests are fixed or injected.

## Pull-request gates

`npm run ci` runs lint, TypeScript validation, OpenAPI drift detection, the production-source secret scan, unit,
route integration, quality, and isolated PostgreSQL suites, migration metadata validation, and a production
build. GitHub CI additionally audits production dependencies at high severity.

The dedicated `npm run test:quality` suite covers:

- property-based decimal round trips, arithmetic laws, exact tolerance decisions, and weighted-median invariants;
- arbitrary-JSON domain and live connector-boundary fuzzing plus explicit hostile/malformed payload shapes;
- golden replay of retained latest-ledger v0.1 and v0.2 methodologies;
- concurrent real-route requests, full worker-job source concurrency, and shared-source SSE polling/fan-out;
- timeout, retry exhaustion, cancellation, and clock-skew failure injection.

The isolated PostgreSQL suite supplies the stateful checks that cannot be proven in memory: migrations,
append-only enforcement, complete-transaction rollback, duplicate finalization/delivery behavior, concurrent
quota enforcement, SSE replay continuity, backup/restore integrity, and the supply connector → worker → database
→ HTTP route → validated response loader → rendered UI vertical proof.

Recorded connector fixtures are redacted, immutable inputs under `tests/fixtures/`. Connector tests exercise
valid, malformed, oversized, mismatched-network, redirect, timeout, and incomplete payload behavior without
contacting a public service.

## Security gates

- `npm run security:secrets` scans every tracked and non-ignored untracked repository file for private-key
  material, provider/API tokens, credential-bearing PostgreSQL URLs, and hard-coded credential assignments. The
  detector runs positive and negative self-tests before every scan.
- `npm run security:dependencies` audits the complete npm dependency tree, including trusted build/test tools.
  GitHub CI runs this separately
  because advisory retrieval requires network access.
- Lint and typecheck are the static-analysis gates.
- Route and PostgreSQL access tests verify missing, invalid, expired, revoked, wrong-scope, disabled-plan,
  burst-limit, and sustained-limit decisions.

The scanner is a preventative gate, not a substitute for provider-side secret scanning or immediate credential
rotation after an exposure.

## Scheduled and operational checks

`.github/workflows/horizon-smoke.yml` runs `npm run smoke:horizon` every six hours and on manual dispatch against
an allow-listed Public Network Horizon host. It validates both network identity and the latest-ledger response
contract. This live check is intentionally absent from ordinary pull requests.

Encrypted database restore drills remain governed by the [data-protection runbook](./runbooks/data-protection.md).
Operational load tests prove bounded fan-out and atomic limits in CI; environment capacity and latency targets
must be exercised against staging again during environment promotion because those results depend on deployment topology.

## Adding coverage

Put pure behavior in `tests/unit`, HTTP boundary behavior in `tests/integration`, database invariants in
`tests/database`, and cross-cutting property/replay/load/failure checks in `tests/quality`. A methodology change
must retain the old executable configuration and add or update a versioned golden replay fixture.
