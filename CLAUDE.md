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
- **`src/main/main.ts`** — Electron bootstrap, IPC handler registration (`chat`, `get-copilot-auth-status`).
- **`src/main/copilotChat.ts`** — `CopilotChat` class: manages Copilot SDK client lifecycle, auth checks, sends prompts, returns text answers. Contains fallback logic if Copilot is unavailable.
- **`src/main/preload.ts`** — Context bridge exposing two IPC methods to renderer.
- **`src/renderer/main.ts`** — Monolithic UI file: state management, DOM manipulation, file parsing, chat display. No framework.
- **`src/renderer/styles.css`** — Tailwind CSS v4 imports.

### Data flow

1. User attaches CSV/Excel/PDF → renderer parses file locally (PapaParse worker for CSV, ExcelJS for Excel, binary passthrough for PDF).
2. Renderer builds a `DocumentContext` (text content for tabular files, binary passthrough for PDFs) and sends it + user prompt + conversation history via IPC.
3. Main process extracts PDF text if needed, builds relevant excerpt, sends to Copilot, receives a markdown text answer.
4. Renderer displays the markdown answer in the chat log.

### Two TypeScript configs

- `tsconfig.electron.json` — Main process (Node, ES2022). Outputs to `dist-electron/`.
- `tsconfig.renderer.json` — Renderer (DOM, ES2022). Vite handles bundling to `dist-renderer/`.
- `tsconfig.base.json` — Shared compiler options inherited by both.

## Design Constraints (from Agents.md)

- **Performance is the top priority.** Keep parsing and model calls off the main UI thread. Log latency for parse, inference, and render stages.
- Copilot fallback: the app must remain functional without Copilot auth — `CopilotChat` returns document excerpts as fallback.
- Multi-turn conversation: the renderer sends conversation history (last 10 messages) with each request for context continuity.

## Requirements

- Node.js >=24.0.0 (required by `@github/copilot-sdk`)
- GitHub Copilot CLI must be authenticated for AI features; UI shows auth gate otherwise.
- Environment variables: `COPILOT_MODEL` (override model), `COPILOT_LOG_LEVEL` (`none|error|warning|info|debug|all`).
