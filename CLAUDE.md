# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Batch Explorer is an Azure Batch account management tool. It's a **Lerna monorepo** with an Electron desktop app (Angular 12) and an experimental web UI (React). Requires **Node.js 18+**.

Workspaces: `desktop`, `packages/*` (bonito-core, bonito-ui, service, react, playground), `util/*` (bux, common-config), `web`.

## Common Commands

```bash
# Setup
npm install && npm run dev-setup

# Build
npm run build              # All packages
npm run build:desktop      # Desktop only
npm run build:web          # Web only
npm run build:prod         # Production build

# Development
npm run launch:desktop     # Dev server + Electron + watch all
npm run start:web          # Web dev server (port 3000)

# Test
npm run test               # All (desktop + web)
npm run test:desktop       # Desktop only (Karma + Jasmine)
npm run test:web           # Web only (Jest)
cd desktop && npm run test-app-watch  # Desktop watch mode
cd desktop && npm run test-e2e        # Playwright E2E

# Lint
npm run lint               # ESLint + Stylelint
npm run lint:fix           # Auto-fix + Prettier
```

Desktop tests run in Karma with Electron as the browser. Web tests use Jest with ts-jest. Spec files are `*.spec.ts`.

## Architecture

### Desktop App (`/desktop`)
- **Angular 12** app bundled with **Webpack 5** for Electron
- Entry: `desktop/src/app/app.module.ts` → `app.routes.ts` (lazy-loaded feature modules)
- TypeScript configs: `tsconfig.browser.json` (renderer), `tsconfig.node.json` (main process)
- Webpack configs: `desktop/config/webpack.config.{base,dev,prod,test}.js`

### State & Data Layer
- **RxJS Observables** throughout; services expose `Observable<List<T>>` with Immutable.js collections
- **Entity/List Getter pattern**: `BatchEntityGetter<T>` + `BatchListGetter<T>` with `DataCache<T>` per service
- Services: `PoolService`, `NodeService`, `JobService`, etc. under `desktop/src/app/services/azure-batch/`
- HTTP: `AzureBatchHttpService` with `requestForAccount(account, method, uri, options)`

### Shared Packages (`/packages`)
- `bonito-core` — HTTP, forms, auth abstractions
- `bonito-ui` — React components (Azure Portal compatible)
- `service` — Data access layer
- `react` — Batch-specific React components

### Key Directories (desktop)
- `src/app/components/` — Feature modules (account, pool, job, node, etc.)
- `src/app/services/` — Angular services
- `src/app/models/` — Data models and DTOs (`models/dtos/` for create/update DTOs)
- `src/client/` — Electron main process code
- `src/common/` — Shared types between main/renderer (e.g., `be-user-configuration.model.ts`)

### Pool Control Workbench
Feature-flagged (`features.poolControlWorkbench`) multi-account pool management at route `/pools/workbench`. Key services in `desktop/src/app/services/workbench/`:
- `RequestScheduler` — bounded concurrency with exponential backoff, jitter, per-key serialization
- `WorkbenchDiscoveryService` — multi-account/region pool enumeration
- `BatchPoolActionsService` / `BatchNodeActionsService` — pool/node operations
- Anti-429 constraints enforced: concurrency=1 default, configurable pacing delay, retry with backoff

## Code Conventions

- **Imports**: Group npm imports first, then local imports. Prefer absolute imports from project root (`"app/..."`) over deep relative paths (`../../..`).
- **Templates**: Use `templateUrl: "abc.html"` for Angular components; inline templates only for simple cases.
- **Formatting**: Prettier with `trailingComma: "es5"`, `endOfLine: "auto"`. ESLint extends `@batch/common-config/eslint`.
- **Tests**: `fdescribe`/`fit` are flagged by ESLint (do not commit focused tests).
- Changes to `/client` code require full app restart (no hot reload for main process).
