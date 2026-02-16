# Document Pilot

High-performance Electron desktop app for AI-powered document analysis with automatic chart generation.

## Stack
- Electron desktop shell
- GitHub Copilot Agents SDK (`@github/copilot-sdk`)
- Model default: `gpt-5-mini`
- Charting: Chart.js
- CSV parsing: Papa Parse (worker mode)
- Excel parsing: ExcelJS (`.xlsx`, `.xlsm`)
- PDF parsing: `pdf-parse` (text extraction + prompt-grounded analysis)

## What It Does
1. Organize work by Projects/Threads, each with multiple chat sessions.
2. Upload a CSV, Excel, or PDF file (`.csv`, `.xlsx`, `.xlsm`, `.pdf`) per session.
3. Ask a question like: `Show me a chart of goal difference in Premier League`.
4. The app asks Copilot SDK for analysis using the selected model/reasoning effort.
5. For tabular files, the renderer computes chart data locally and renders with Chart.js.
6. For PDF files, the app extracts text and returns structured analysis in chat.
7. If Copilot is unavailable, deterministic fallback logic still returns output.

## Setup
0. Use Node.js 24+ (`@github/copilot-sdk` requires `>=24.0.0`).
1. Install dependencies:
```bash
npm install
```
2. Ensure GitHub Copilot CLI is installed and authenticated (required to use the app).
   If not authenticated, the UI blocks analysis and prompts login.
3. Optional env vars:
```bash
export COPILOT_MODEL=gpt-5-mini
export COPILOT_LOG_LEVEL=error
```

## Run
```bash
npm run dev
```

## Build
```bash
npm run build
```

## Performance Notes
- CSV parsing runs in a worker.
- Chart rendering uses `animation: false`, `parsing: false`, `normalized: true` for lower overhead.
- Main process logs plan latency and avoids sending full raw datasets to the model.
