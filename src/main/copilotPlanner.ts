import { performance } from 'node:perf_hooks';
import { CopilotClient } from '@github/copilot-sdk';
import type {
  AnalyzeDatasetRequest,
  AnalyzeDatasetResponse,
  CopilotAuthStatusRequest,
  CopilotAuthStatusResponse,
  AnalyzePdfRequest,
  AnalyzePdfResponse,
  ReasoningEffort,
  VisualizationPlan
} from '../shared/contracts.js';

const DEFAULT_MODEL = process.env.COPILOT_MODEL ?? 'gpt-5-mini';
const LOG_LEVELS = ['none', 'error', 'warning', 'info', 'debug', 'all'] as const;
type CopilotLogLevel = (typeof LOG_LEVELS)[number];

const GOALS_FOR_ALIASES = ['goals_for', 'goals for', 'gf', 'goals scored', 'for'];
const GOALS_AGAINST_ALIASES = ['goals_against', 'goals against', 'ga', 'goals conceded', 'against'];
const TEAM_ALIASES = ['team', 'club', 'name', 'squad'];
const MAX_PDF_CONTEXT_CHARS = 20_000;

class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ');
}

function detectField(headers: string[], aliases: string[]): string | undefined {
  const normalized = headers.map((header) => ({
    original: header,
    normalized: normalize(header)
  }));

  for (const alias of aliases) {
    const direct = normalized.find((h) => h.normalized === normalize(alias));
    if (direct) return direct.original;
  }

  for (const alias of aliases) {
    const partial = normalized.find((h) => h.normalized.includes(normalize(alias)));
    if (partial) return partial.original;
  }

  return undefined;
}

function resolveLogLevel(value: string | undefined): CopilotLogLevel {
  if (!value) return 'error';
  return LOG_LEVELS.includes(value as CopilotLogLevel) ? (value as CopilotLogLevel) : 'error';
}

function pickPromptMatchedField(prompt: string, headers: string[]): string | undefined {
  const normalizedPrompt = normalize(prompt);
  return headers.find((header) => normalizedPrompt.includes(normalize(header)));
}

function resolveModel(requested?: string): string {
  const safe = requested?.trim();
  return safe && safe.length > 0 ? safe : DEFAULT_MODEL;
}

function resolveReasoningEffort(requested?: ReasoningEffort): ReasoningEffort | undefined {
  if (requested === 'low' || requested === 'medium' || requested === 'high' || requested === 'xhigh') {
    return requested;
  }
  return undefined;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'Unable to connect to Copilot SDK.';
}

function fallbackPlan(input: AnalyzeDatasetRequest): AnalyzeDatasetResponse {
  const startedAt = performance.now();
  const { headers, numericColumns } = input.dataset;
  const lowerPrompt = normalize(input.prompt);
  const model = resolveModel(input.model);

  const xField = detectField(headers, TEAM_ALIASES) ?? headers[0] ?? 'Category';
  const yField = pickPromptMatchedField(input.prompt, numericColumns) ?? numericColumns[0];

  let plan: VisualizationPlan = {
    chartType: lowerPrompt.includes('trend') || lowerPrompt.includes('over time') ? 'line' : 'bar',
    title: 'Generated chart',
    xField,
    yField,
    sort: 'desc',
    maxPoints: 20,
    reason: 'Fallback planner used due to unavailable Copilot response.'
  };

  if (lowerPrompt.includes('goal difference')) {
    plan = {
      chartType: 'bar',
      title: 'Premier League Goal Difference',
      xField,
      derivedMetric: 'goal_difference',
      sort: 'desc',
      maxPoints: 20,
      reason: 'Goal difference requested in prompt.'
    };
  } else if (lowerPrompt.includes('share') || lowerPrompt.includes('composition')) {
    plan.chartType = 'doughnut';
    plan.sort = 'none';
    plan.maxPoints = 8;
  }

  const hasGoalColumns =
    detectField(headers, GOALS_FOR_ALIASES) && detectField(headers, GOALS_AGAINST_ALIASES);

  if (plan.derivedMetric === 'goal_difference' && !hasGoalColumns) {
    plan = {
      ...plan,
      derivedMetric: undefined,
      yField: yField ?? numericColumns[0],
      reason: 'Goal columns were not detected. Switched to numeric fallback.'
    };
  }

  return {
    plan,
    source: 'fallback',
    model,
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    warning: 'Copilot SDK unavailable or response parsing failed. Used deterministic fallback.'
  };
}

function extractJsonObject(content: string): string {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in Copilot response.');
  }
  return content.slice(start, end + 1);
}

function sanitizePlan(input: AnalyzeDatasetRequest, parsed: Partial<VisualizationPlan>): VisualizationPlan {
  const headers = input.dataset.headers;
  const numericColumns = input.dataset.numericColumns;

  const fallback = fallbackPlan(input).plan;

  const maxPoints =
    typeof parsed.maxPoints === 'number' && Number.isFinite(parsed.maxPoints)
      ? Math.max(5, Math.min(100, Math.floor(parsed.maxPoints)))
      : fallback.maxPoints;

  const chartType: VisualizationPlan['chartType'] =
    parsed.chartType === 'bar' ||
    parsed.chartType === 'line' ||
    parsed.chartType === 'pie' ||
    parsed.chartType === 'doughnut'
      ? parsed.chartType
      : fallback.chartType;

  const sort: VisualizationPlan['sort'] =
    parsed.sort === 'asc' || parsed.sort === 'desc' || parsed.sort === 'none' ? parsed.sort : fallback.sort;

  const xField =
    typeof parsed.xField === 'string' && headers.includes(parsed.xField) ? parsed.xField : fallback.xField;

  const yField =
    typeof parsed.yField === 'string' && numericColumns.includes(parsed.yField)
      ? parsed.yField
      : fallback.yField;

  const derivedMetric = parsed.derivedMetric === 'goal_difference' ? 'goal_difference' : undefined;

  const safeTitle = typeof parsed.title === 'string' && parsed.title.trim().length > 0 ? parsed.title : fallback.title;
  const safeReason = typeof parsed.reason === 'string' && parsed.reason.trim().length > 0 ? parsed.reason : fallback.reason;

  return {
    chartType,
    title: safeTitle,
    xField,
    yField,
    derivedMetric,
    sort,
    maxPoints,
    reason: safeReason
  };
}

function buildRelevantPdfExcerpt(prompt: string, text: string): string {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  if (normalizedText.length <= MAX_PDF_CONTEXT_CHARS) {
    return normalizedText;
  }

  const terms = Array.from(new Set((prompt.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).slice(0, 16)));
  if (terms.length === 0) {
    return normalizedText.slice(0, MAX_PDF_CONTEXT_CHARS);
  }

  const chunkSize = 1200;
  const chunks: Array<{ index: number; text: string; score: number }> = [];

  for (let i = 0; i < normalizedText.length; i += chunkSize) {
    const chunk = normalizedText.slice(i, i + chunkSize);
    const lower = chunk.toLowerCase();
    const score = terms.reduce((acc, term) => acc + (lower.includes(term) ? 1 : 0), 0);
    chunks.push({ index: i, text: chunk, score });
  }

  const ranked = chunks
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .sort((a, b) => a.index - b.index);

  if (ranked.length === 0) {
    return normalizedText.slice(0, MAX_PDF_CONTEXT_CHARS);
  }

  const merged = ranked.map((chunk) => chunk.text).join('\n\n');
  return merged.slice(0, MAX_PDF_CONTEXT_CHARS);
}

function buildPdfFallbackAnalysis(prompt: string, excerpt: string): string {
  const summary = excerpt
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' ');

  return [
    `Fallback analysis for: "${prompt}"`,
    '',
    summary || excerpt.slice(0, 800) || 'The PDF did not contain extractable text.'
  ].join('\n');
}

export class CopilotPlanner {
  private client: CopilotClient | null = null;

  async stop(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.stop();
    } catch {
      await this.client.forceStop();
    } finally {
      this.client = null;
    }
  }

  private async getClient(): Promise<CopilotClient> {
    if (!this.client) {
      this.client = new CopilotClient({
        autoStart: true,
        useStdio: true,
        logLevel: resolveLogLevel(process.env.COPILOT_LOG_LEVEL)
      });
      await this.client.start();
    }
    return this.client;
  }

  async getCopilotAuthStatus(input: CopilotAuthStatusRequest = {}): Promise<CopilotAuthStatusResponse> {
    const model = resolveModel(input.model);

    try {
      const client = await this.getClient();
      const auth = await client.getAuthStatus();

      let modelAvailable: boolean | undefined;
      if (auth.isAuthenticated) {
        try {
          const models = await client.listModels();
          modelAvailable = models.some((entry) => entry.id === model);
        } catch {
          modelAvailable = undefined;
        }
      }

      const statusMessage = auth.isAuthenticated
        ? modelAvailable === false
          ? `Authenticated as ${auth.login ?? 'user'}, but model "${model}" is not available for this account.`
          : `Authenticated as ${auth.login ?? 'user'}.`
        : auth.statusMessage || 'Not authenticated. Please sign in with GitHub Copilot.';

      return {
        ok: true,
        isAuthenticated: auth.isAuthenticated,
        authType: auth.authType,
        login: auth.login,
        host: auth.host,
        statusMessage,
        model,
        modelAvailable,
        checkedAt: Date.now()
      };
    } catch (error) {
      return {
        ok: false,
        isAuthenticated: false,
        statusMessage: extractErrorMessage(error),
        model,
        checkedAt: Date.now()
      };
    }
  }

  private async ensureAuthenticated(model?: string): Promise<void> {
    const auth = await this.getCopilotAuthStatus({ model });

    if (!auth.ok) {
      throw new AuthRequiredError(`Copilot SDK unavailable: ${auth.statusMessage}`);
    }

    if (!auth.isAuthenticated) {
      throw new AuthRequiredError(`GitHub login required: ${auth.statusMessage}`);
    }

    if (auth.modelAvailable === false) {
      throw new AuthRequiredError(`Selected model "${auth.model}" is not available for this account.`);
    }
  }

  async planVisualization(input: AnalyzeDatasetRequest): Promise<AnalyzeDatasetResponse> {
    const startedAt = performance.now();
    const model = resolveModel(input.model);
    const reasoningEffort = resolveReasoningEffort(input.reasoningEffort);

    await this.ensureAuthenticated(model);

    try {
      const client = await this.getClient();
      const session = await client.createSession({
        model,
        reasoningEffort
      });

      const prompt = [
        'You are a data visualization planner for a desktop analytics app.',
        'Return ONLY valid JSON with this exact shape and no markdown:',
        '{',
        '  "chartType": "bar" | "line" | "pie" | "doughnut",',
        '  "title": "string",',
        '  "xField": "string",',
        '  "yField": "string optional",',
        '  "derivedMetric": "goal_difference" optional,',
        '  "sort": "asc" | "desc" | "none",',
        '  "maxPoints": number,',
        '  "reason": "string"',
        '}',
        '',
        'Rules:',
        '- Use only fields present in dataset headers.',
        '- If user asks for goal difference, set derivedMetric="goal_difference".',
        '- Prefer bar for ranking, line for time trends, doughnut/pie for share with few categories.',
        '- Keep maxPoints between 5 and 100.',
        '',
        `User prompt: ${input.prompt}`,
        `Dataset summary JSON: ${JSON.stringify(input.dataset)}`
      ].join('\n');

      const response = await session.sendAndWait({ prompt }, 45_000);
      await session.destroy();

      const content = response?.data.content ?? '';
      const json = extractJsonObject(content);
      const parsed = JSON.parse(json) as Partial<VisualizationPlan>;
      const plan = sanitizePlan(input, parsed);

      return {
        plan,
        source: 'copilot',
        model,
        latencyMs: Number((performance.now() - startedAt).toFixed(2))
      };
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        throw error;
      }
      return fallbackPlan(input);
    }
  }

  async analyzePdf(input: AnalyzePdfRequest): Promise<AnalyzePdfResponse> {
    const startedAt = performance.now();
    const model = resolveModel(input.model);
    const reasoningEffort = resolveReasoningEffort(input.reasoningEffort);

    await this.ensureAuthenticated(model);

    try {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({
        data: Buffer.from(input.pdfData)
      });

      let textResult: Awaited<ReturnType<typeof parser.getText>>;
      try {
        textResult = await parser.getText();
      } finally {
        await parser.destroy().catch(() => undefined);
      }

      const rawText = textResult.text ?? '';
      const extractedText = rawText.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const excerpt = buildRelevantPdfExcerpt(input.prompt, extractedText);

      if (!excerpt) {
        return {
          analysis: 'No extractable text was found in this PDF.',
          source: 'fallback',
          model,
          latencyMs: Number((performance.now() - startedAt).toFixed(2)),
          pageCount: textResult.total ?? 0,
          extractedChars: 0,
          warning: 'PDF parsing succeeded but returned empty text.'
        };
      }

      try {
        const client = await this.getClient();
        const session = await client.createSession({
          model,
          reasoningEffort
        });
        try {
          const prompt = [
            'You are an expert document analyst for a desktop app.',
            'Use only the provided extracted PDF text.',
            'If the text is insufficient, clearly say what is missing.',
            'Respond in concise markdown with these sections:',
            '1) Answer',
            '2) Key Evidence',
            '3) Caveats',
            '',
            `User question: ${input.prompt}`,
            `File name: ${input.fileName}`,
            `PDF pages: ${textResult.total ?? 0}`,
            '',
            'Extracted PDF text:',
            excerpt
          ].join('\n');

          const response = await session.sendAndWait({ prompt }, 60_000);

          const content = response?.data.content?.trim();
          if (!content) {
            throw new Error('Copilot returned an empty response.');
          }

          return {
            analysis: content,
            source: 'copilot',
            model,
            latencyMs: Number((performance.now() - startedAt).toFixed(2)),
            pageCount: textResult.total ?? 0,
            extractedChars: extractedText.length
          };
        } finally {
          await session.destroy().catch(() => undefined);
        }
      } catch {
        return {
          analysis: buildPdfFallbackAnalysis(input.prompt, excerpt),
          source: 'fallback',
          model,
          latencyMs: Number((performance.now() - startedAt).toFixed(2)),
          pageCount: textResult.total ?? 0,
          extractedChars: extractedText.length,
          warning: 'Copilot response failed, using deterministic fallback.'
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown PDF parsing error';
      return {
        analysis: `Unable to analyze PDF: ${message}`,
        source: 'fallback',
        model,
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        pageCount: 0,
        extractedChars: 0,
        warning: 'PDF parsing failed.'
      };
    }
  }
}
