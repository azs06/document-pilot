import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CopilotClient } from '@github/copilot-sdk';
import type {
  ChatRequest,
  ChatResponse,
  CopilotAuthStatusRequest,
  CopilotAuthStatusResponse,
  ReasoningEffort
} from '../shared/contracts.js';

const DEFAULT_MODEL = process.env.COPILOT_MODEL ?? 'gpt-5-mini';
const LOG_LEVELS = ['none', 'error', 'warning', 'info', 'debug', 'all'] as const;
type CopilotLogLevel = (typeof LOG_LEVELS)[number];

const MAX_PDF_CONTEXT_CHARS = 20_000;
const MAX_HISTORY_MESSAGES = 10;

class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

function resolveLogLevel(value: string | undefined): CopilotLogLevel {
  if (!value) return 'error';
  return LOG_LEVELS.includes(value as CopilotLogLevel) ? (value as CopilotLogLevel) : 'error';
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

function buildFallbackAnswer(prompt: string, excerpt: string): string {
  const summary = excerpt
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' ');

  return [
    `Copilot is unavailable. Here is a relevant excerpt for: "${prompt}"`,
    '',
    summary || excerpt.slice(0, 800) || 'The document did not contain extractable text.'
  ].join('\n');
}

export class CopilotChat {
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

  private resolveNodeBinary(): string {
    // Find the system Node.js binary so the Copilot CLI runs as plain Node
    // instead of Electron (which would show a second macOS dock icon).
    try {
      return execFileSync('/usr/bin/which', ['node'], { encoding: 'utf-8' }).trim();
    } catch {
      return 'node';
    }
  }

  private resolveCopilotCliPath(): string {
    // Resolve @github/copilot/index.js the same way the SDK does internally:
    // import.meta.resolve('@github/copilot/sdk') → .../copilot/sdk/index.js
    // then go up two directories to get .../copilot/index.js
    const sdkUrl = import.meta.resolve('@github/copilot/sdk');
    const sdkPath = fileURLToPath(sdkUrl);
    return path.join(path.dirname(path.dirname(sdkPath)), 'index.js');
  }

  private async getClient(): Promise<CopilotClient> {
    if (!this.client) {
      // The Copilot SDK spawns its CLI using process.execPath (the Electron
      // binary) when cliPath ends in .js, which creates a second macOS dock
      // icon. To avoid this, we set cliPath to the system `node` binary (not
      // .js) and pass the actual CLI script path via cliArgs. The SDK then
      // runs: spawn(nodeBinary, [copilotIndex.js, ...args])
      const nodeBin = this.resolveNodeBinary();
      const copilotCli = this.resolveCopilotCliPath();

      this.client = new CopilotClient({
        autoStart: true,
        useStdio: true,
        logLevel: resolveLogLevel(process.env.COPILOT_LOG_LEVEL),
        cliPath: nodeBin,
        cliArgs: [copilotCli]
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

  private async extractPdfText(pdfData: ArrayBuffer): Promise<{ text: string; pageCount: number }> {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: Buffer.from(pdfData) });

    try {
      const result = await parser.getText();
      const raw = result.text ?? '';
      const text = raw.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      return { text, pageCount: result.total ?? 0 };
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  private buildSystemPrompt(documentKind: string): string {
    const kindHint =
      documentKind === 'pdf'
        ? 'When citing information, reference the relevant section or page context.'
        : 'When citing information, reference column names and specific cell values.';

    return [
      'You are a document analysis assistant.',
      'Use the provided document content as your primary source, supplemented by general knowledge when it adds value.',
      kindHint,
      'If the document does not contain enough information to answer, say so, then offer what you can.',
      'Pick the best markdown format for each answer — tables, lists, or paragraphs — whatever fits.',
      'Be direct: no filler preamble.',
    ].join(' ');
  }

  async chat(input: ChatRequest): Promise<ChatResponse> {
    const startedAt = performance.now();
    const model = resolveModel(input.model);
    const reasoningEffort = resolveReasoningEffort(input.reasoningEffort);

    await this.ensureAuthenticated(model);

    let documentText = input.document.textContent;

    if (input.document.kind === 'pdf' && input.document.pdfData) {
      try {
        const { text } = await this.extractPdfText(input.document.pdfData);
        documentText = text;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown PDF parsing error';
        return {
          answer: `Unable to read PDF: ${message}`,
          source: 'fallback',
          model,
          latencyMs: Number((performance.now() - startedAt).toFixed(2)),
          warning: 'PDF parsing failed.'
        };
      }
    }

    const excerpt = buildRelevantPdfExcerpt(input.prompt, documentText);

    if (!excerpt) {
      return {
        answer: 'The document did not contain extractable text.',
        source: 'fallback',
        model,
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        warning: 'No text content found in document.'
      };
    }

    try {
      const client = await this.getClient();
      const session = await client.createSession({ model, reasoningEffort });

      try {
        const systemPrompt = this.buildSystemPrompt(input.document.kind);

        const historyBlock = (input.history ?? [])
          .slice(-MAX_HISTORY_MESSAGES)
          .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
          .join('\n\n');

        const prompt = [
          systemPrompt,
          '',
          `Document: ${input.document.fileName}`,
          input.document.rowCount ? `Rows: ${input.document.rowCount}` : '',
          input.document.pageCount ? `Pages: ${input.document.pageCount}` : '',
          '',
          'Document content:',
          excerpt,
          '',
          historyBlock ? `Conversation so far:\n${historyBlock}\n` : '',
          `User question: ${input.prompt}`
        ]
          .filter(Boolean)
          .join('\n');

        const response = await session.sendAndWait({ prompt }, 60_000);
        const content = response?.data.content?.trim();

        if (!content) {
          throw new Error('Copilot returned an empty response.');
        }

        return {
          answer: content,
          source: 'copilot',
          model,
          latencyMs: Number((performance.now() - startedAt).toFixed(2))
        };
      } finally {
        await session.destroy().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        throw error;
      }

      return {
        answer: buildFallbackAnswer(input.prompt, excerpt),
        source: 'fallback',
        model,
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        warning: 'Copilot response failed, using document excerpt as fallback.'
      };
    }
  }
}
