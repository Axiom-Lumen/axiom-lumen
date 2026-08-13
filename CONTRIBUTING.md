# Contributing to Axiom Lumen

This repository contains the Next.js web experience and durable reconciliation pipelines for latest-ledger,
supply, classic SDEX depth, trustline state, and publication-gated anchor reserve data. Leased workers persist
finalized PostgreSQL snapshots that public routes serve without request-time upstream fan-out.

The goal of this guide is to make the contributor path clear without pretending that more backend functionality exists than is actually present.

## 1. Current implementation status

The current repository supports:

- a Next.js web app for the marketing and documentation experience
- `GET /api/v1/stellar/latest-ledger`
- a multi-Horizon latest-ledger connector and reconciliation module
- PostgreSQL migrations, transactional audit repositories, and an idempotent background worker
- API authentication, quotas, snapshot SSE, operational status, and data-protection tooling
- unit, property, fuzz, replay, load, failure-injection, route integration, and real PostgreSQL tests
- CI for static analysis, contracts, security gates, tests, migration validation, and production build

Automated deployment environments and production promotion remain roadmap work. Keep every contribution honest
about the difference between repository capability and deployed production behavior.

## 2. Target architecture

Axiom Lumen is intended to follow a three-stage pipeline:

```text
INGEST → RECONCILE → SERVE
```

- INGEST: collect raw observations from Stellar endpoints and any other supported sources.
- RECONCILE: compare observations, apply methodology rules, and record discrepancies.
- SERVE: expose verified outputs through the web experience and future API surfaces.

The metric pipelines implement all three stages with PostgreSQL between background ingestion and serving.
Public requests do not perform upstream collection.

## 3. Prerequisites

Before contributing, install the following:

- Node.js 22.13 or newer (the repository pins Node 22 in [.nvmrc](.nvmrc))
- npm 10 or newer
- Docker Desktop or another local Docker runtime for PostgreSQL development and database tests

## 4. Initial setup

1. Clone the repository and change into it:

   ```bash
   git clone <repository-url>
   cd axiom-lumen
   ```

2. Use the pinned Node version:

   ```bash
   nvm install
   nvm use
   ```

3. Install dependencies:

   ```bash
   npm ci
   ```

4. Copy the example environment file:

   ```bash
   cp .env.example .env.local
   ```

5. Review the database and worker values in [.env.local](.env.local), then follow [docs/worker.md](docs/worker.md)
   to migrate PostgreSQL and register a Horizon source.

## 5. Local development workflow

### 5.1 Start the web app

Run the frontend locally:

```bash
npm run dev
```

Then open http://localhost:3000.

### 5.2 Run ingestion and exercise the implemented API

Run a one-shot worker, start the development server, then query the persisted snapshot:

```bash
npm run worker:once
npm run dev
curl http://localhost:3000/api/v1/stellar/latest-ledger
```

Use `npm run worker:continuous` for the long-running process. Database commands and lease behavior are documented
in [docs/database.md](docs/database.md) and [docs/worker.md](docs/worker.md).

## 6. Tests and quality checks

Run the same aggregate check used by CI before opening a pull request:

```bash
npm run ci
```

The individual `lint`, `typecheck`, `test`, `test:integration`, `test:quality`, `test:database`,
`security:secrets`, and `build` scripts are also available. The complete lane ownership, determinism rules,
scheduled Horizon smoke check, and security gates are documented in
[docs/quality-strategy.md](docs/quality-strategy.md). Add focused tests for new behavior rather than relying only
on existing coverage.

## 7. Methodology change policy

Any change to the reconciliation methodology requires a version bump. This includes:

- weights
- thresholds
- decay parameters
- tolerance bands
- severity rules

The canonical product rules document is [axiom-lumen-agent-guide.md](axiom-lumen-agent-guide.md). Any methodology change should be reflected there and in the public methodology copy.

Broad product direction is maintained in the [public roadmap](docs/implementation-roadmap.md). Detailed sequencing and internal acceptance criteria are maintained privately. `docs/issue-backlog.md` is a historical pre-backend audit, not the current execution plan.

## 8. Pull request checklist

Before opening a PR, confirm the following:

- [ ] The change is documented accurately for the current implementation status.
- [ ] Relevant tests were run and passed.
- [ ] If the change affects methodology logic, the methodology version was bumped.
- [ ] If the change affects user-facing copy, the language in [axiom-lumen-agent-guide.md](axiom-lumen-agent-guide.md) section 6 was reviewed.
- [ ] The change does not overstate backend functionality that is not present in the checkout.

## 9. Notes for contributors

- Keep documentation factual and explicit about what is implemented today versus what is planned.
- Prefer neutral, descriptive language for product copy and documentation.
- When you add or change user-facing copy, review the language guardrails in [axiom-lumen-agent-guide.md](axiom-lumen-agent-guide.md).
