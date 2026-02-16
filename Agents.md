# Agents.md

## Vision
Build a high-performance Electron desktop app for AI-powered document analysis, with automatic data visualization when it improves understanding.

## Core Stack Decisions
1. App shell: Electron.
2. Agent framework: Copilot Agents SDK.
3. Primary model: `gpt-5-mini`.
4. Charts: HTML-embedded charts using `Chart.js` (popular, low setup, strong ecosystem).

## Non-Negotiable Priorities
1. Performance is the top priority.
2. Keep UI responsive under heavy parsing/analysis loads.
3. Prefer streaming, incremental rendering, and background processing.
4. Minimize memory overhead for large files.

## Agent Behavior Requirements
1. The agent must decide when a chart is more useful than plain text.
2. For tabular inputs (CSV/Excel-like structure), infer useful chart candidates from user intent.
3. If user intent includes comparison, trend, distribution, or ranking, default to chart + short explanation.
4. If intent is ambiguous, ask one focused clarification question; otherwise proceed with best-effort assumptions.

## Data Visualization Rules
1. Use `Chart.js` for initial implementation.
2. Default chart selection:
   - Ranking/comparison -> bar chart.
   - Time progression -> line chart.
   - Share/composition -> pie/doughnut (only for small category counts).
3. Always include axis labels, units, and readable legends.
4. Render chart in HTML view inside Electron.

## Example Use Case (Required)
User uploads a CSV and asks: "Show me a chart of goal difference in Premier League."

Expected agent flow:
1. Parse CSV and detect relevant columns (team, goals for, goals against, etc.).
2. Compute goal difference (`goals_for - goals_against`) per team.
3. Sort descending by goal difference.
4. Render a bar chart with teams on X-axis and goal difference on Y-axis.
5. Provide a concise textual summary of top and bottom teams.

## Implementation Notes
1. Keep parsing and model calls off the main UI thread.
2. Cache parsed datasets and derived metrics when possible.
3. Re-render only changed chart regions/state.
4. Log latency for parse, inference, and render stages.
5. Treat the above behavior as baseline acceptance criteria.
