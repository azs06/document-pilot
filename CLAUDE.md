# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # Start dev (Vite renderer on :5173 + Electron, parallel)
npm run build          # Production build (renderer then electron)
npm run start          # Build + launch Electron
npm run typecheck      # Type-check both electron and renderer tsconfigs
npm run build:electron # Compile main process only (tsc -p tsconfig.electron.json)
npm run build:renderer # Bundle renderer only (vite build)
```

No test runner or linter is configured.

## Architecture

Electron app with three process boundaries communicating via typed IPC:

```
Renderer (Vite + vanilla TS + Tailwind)
   ↕ contextBridge (preload.ts exposes window.documentPilot)
Main Process (Node + Copilot SDK)
   ↕ @github/copilot-sdk stdio transport
GitHub Copilot LLM (default: gpt-5-mini)
```

### Key files

- **`src/shared/contracts.ts`** — All IPC request/response types. Both processes import from here. Edit this first when changing the API surface.
- **`src/main/main.ts`** — Electron bootstrap, IPC handler registration (`analyze-dataset`, `analyze-pdf`, `get-copilot-auth-status`).
- **`src/main/copilotPlanner.ts`** — `CopilotPlanner` class: manages Copilot SDK client lifecycle, auth checks, sends prompts, parses `VisualizationPlan` JSON. Contains deterministic fallback logic if Copilot is unavailable.
- **`src/main/preload.ts`** — Context bridge exposing three IPC methods to renderer.
- **`src/renderer/main.ts`** — Monolithic UI file: state management, DOM manipulation, file parsing, chart rendering. No framework.
- **`src/renderer/styles.css`** — Tailwind CSS v4 imports.

### Data flow

1. User attaches CSV/Excel/PDF → renderer parses file locally (PapaParse worker for CSV, ExcelJS for Excel, binary passthrough for PDF).
2. Renderer builds a `DatasetSummary` (headers, sample rows, numeric columns) and sends it + user prompt via IPC.
3. Main process sends summary to Copilot, receives a `VisualizationPlan` (chart type, fields, sort, derived metrics).
4. **Renderer computes chart data locally** from the full dataset using the plan — raw data never leaves the renderer for tabular files.
5. Chart.js renders with performance flags (`animation: false`, `parsing: false`, `normalized: true`).

### Two TypeScript configs

- `tsconfig.electron.json` — Main process (Node, ES2022). Outputs to `dist-electron/`.
- `tsconfig.renderer.json` — Renderer (DOM, ES2022). Vite handles bundling to `dist-renderer/`.
- `tsconfig.base.json` — Shared compiler options inherited by both.

## Design Constraints (from Agents.md)

- **Performance is the top priority.** Keep parsing and model calls off the main UI thread. Log latency for parse, inference, and render stages.
- Copilot fallback: the app must remain functional without Copilot auth — `CopilotPlanner` generates deterministic plans as fallback.
- Chart selection defaults: bar for ranking/comparison, line for time progression, pie/doughnut for small-category composition.
- Derived metrics (e.g. `goal_difference`) are computed renderer-side, not by the model.

## Requirements

- Node.js >=24.0.0 (required by `@github/copilot-sdk`)
- GitHub Copilot CLI must be authenticated for AI features; UI shows auth gate otherwise.
- Environment variables: `COPILOT_MODEL` (override model), `COPILOT_LOG_LEVEL` (`none|error|warning|info|debug|all`).
