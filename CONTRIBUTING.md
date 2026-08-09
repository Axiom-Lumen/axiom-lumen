# Contributing to Axiom Lumen

This repository is in an early implementation stage. It contains the Next.js web experience and one real backend vertical slice: multiple Stellar Horizon endpoints can be queried, checked for network identity, reconciled for their latest closed ledger, and served through a local API route.

The goal of this guide is to make the contributor path clear without pretending that more backend functionality exists than is actually present.

## 1. Current implementation status

The current repository supports:

- a Next.js web app for the marketing and documentation experience
- `GET /api/v1/stellar/latest-ledger`
- a multi-Horizon latest-ledger connector and reconciliation module
- unit and route integration tests
- CI for lint, typecheck, tests, integration tests, and production build

The following are not yet implemented in this checkout:

- a background ingest worker
- a reusable metric-agnostic reconciliation engine with persisted methodology state
- database migrations and seed scripts
- a production API layer backed by Postgres

If you are working on backend pieces, treat the sections below as the target architecture and keep the implementation honest about what is currently available.

## 2. Target architecture

Axiom Lumen is intended to follow a three-stage pipeline:

```text
INGEST → RECONCILE → SERVE
```

- INGEST: collect raw observations from Stellar endpoints and any other supported sources.
- RECONCILE: compare observations, apply methodology rules, and record discrepancies.
- SERVE: expose verified outputs through the web experience and future API surfaces.

The latest-ledger endpoint implements a narrow version of all three stages in the request lifecycle. Durable background ingestion, shared methodology configuration, and database-backed serving remain planned.

## 3. Prerequisites

Before contributing, install the following:

- Node.js 22.13 or newer (the repository pins Node 22 in [.nvmrc](.nvmrc))
- npm 10 or newer
- Docker Desktop or another local Docker runtime will be needed when Postgres persistence is implemented

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

5. Review the environment values in [.env.local](.env.local). At least one HTTP or HTTPS Horizon URL is required to call the latest-ledger endpoint.

## 5. Local development workflow

### 5.1 Start the web app

Run the frontend locally:

```bash
npm run dev
```

Then open http://localhost:3000.

### 5.2 Exercise the implemented API

With `STELLAR_HORIZON_URLS` configured and the development server running:

```bash
curl http://localhost:3000/api/v1/stellar/latest-ledger
```

Database and background-worker commands will be documented when those implementations land. Do not rely on `db:*` or `ingest:*` scripts until they exist in `package.json`.

## 6. Tests and quality checks

Run the same aggregate check used by CI before opening a pull request:

```bash
npm run ci
```

The individual `lint`, `typecheck`, `test`, `test:integration`, and `build` scripts are also available. Add focused tests for new behavior rather than relying only on existing coverage.

## 7. Methodology change policy

Any change to the reconciliation methodology requires a version bump. This includes:

- weights
- thresholds
- decay parameters
- tolerance bands
- severity rules

The canonical product rules document is [axiom-lumen-agent-guide.md](axiom-lumen-agent-guide.md). Any methodology change should be reflected there and in the public methodology copy.

The ordered remaining work and acceptance criteria are maintained in [docs/implementation-roadmap.md](docs/implementation-roadmap.md). `docs/issue-backlog.md` is a historical pre-backend audit, not the current execution plan.

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
