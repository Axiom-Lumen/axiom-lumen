# Contributing to Axiom Lumen

This repository is in an early, presentation-focused state. The current checkout contains the polished Next.js web experience, but the ingest worker, reconciliation engine, and database-backed API layer are still planned work rather than fully implemented services.

The goal of this guide is to make the contributor path clear without pretending that more backend functionality exists than is actually present.

## 1. Current implementation status

The current repository supports:

- a Next.js web app for the marketing and documentation experience
- local development of the frontend shell

The following are not yet implemented in this checkout:

- a background ingest worker
- a reconciliation engine with persisted methodology state
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

This repository currently only covers the SERVE surface in a frontend sense. The other stages are documented here as the intended target state, not as implemented services.

## 3. Prerequisites

Before contributing, install the following:

- Node.js 20 or newer (the repository pins Node 22 in [.nvmrc](.nvmrc))
- npm 10 or newer
- Docker Desktop or another local Docker runtime for Postgres

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
   npm install
   ```

4. Copy the example environment file:

   ```bash
   cp .env.example .env.local
   ```

5. Review the environment values in [.env.local](.env.local) and adjust them if needed. The defaults assume a local Postgres instance.

## 5. Local development workflow

### 5.1 Start the web app

Run the frontend locally:

```bash
npm run dev
```

Then open http://localhost:3000.

### 5.2 Start the database

The target architecture expects Postgres. A local container is the simplest way to get started:

```bash
docker run --name axiom-lumen-postgres \
  -e POSTGRES_DB=axiom_lumen \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  -d postgres:16
```

If you already have a running Postgres instance, point DATABASE_URL at that instance instead.

### 5.3 Run the ingest worker

The ingest worker is not implemented in this checkout. The intended command is:

```bash
npm run ingest:run
```

At the moment that command only prints a notice so contributors know the workflow is planned but not yet available.

### 5.4 Run database migrations and seed data

The database workflow is also planned rather than implemented in the current checkout. The intended commands are:

```bash
npm run db:migrate
npm run db:seed
```

These commands currently report that the workflow is not implemented yet.

## 6. Tests and quality checks

Run the available checks before opening a pull request:

```bash
npm run test
npm run lint
npm run typecheck
npm run build
```

If you are adding backend functionality, add real tests rather than only relying on the placeholder commands above.

## 7. Methodology change policy

Any change to the reconciliation methodology requires a version bump. This includes:

- weights
- thresholds
- decay parameters
- tolerance bands
- severity rules

The canonical product rules document is [axiom-lumen-agent-guide.md](axiom-lumen-agent-guide.md). Any methodology change should be reflected there and in the public methodology copy.

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
