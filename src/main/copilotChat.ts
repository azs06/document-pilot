import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CopilotClient } from '@github/copilot-sdk';
import type {
  ApprovalRequest,
  ArtifactRecord,
  CopilotAuthStatusRequest,
  CopilotAuthStatusResponse,
  PermissionArea,
  PermissionGrant,
  PlanStep,
  ReasoningEffort,
  ResolveApprovalRequest,
  ResolveApprovalResponse,
  RiskLevel,
  StartRunRequest,
  StartRunResponse,
  TaskRun
} from '../shared/contracts.js';

const DEFAULT_MODEL = process.env.COPILOT_MODEL ?? 'gpt-5-mini';
const LOG_LEVELS = ['none', 'error', 'warning', 'info', 'debug', 'all'] as const;
type CopilotLogLevel = (typeof LOG_LEVELS)[number];

const MAX_RECENT_PROMPTS = 6;
const MAX_ATTACHMENT_SUMMARY_LENGTH = 1500;

class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

interface DraftPlan {
  summary: string;
  responseMarkdown: string;
  planSteps: Array<{
    title: string;
    description: string;
    toolFamily: string;
    risk: RiskLevel;
    requiresApproval: boolean;
  }>;
  approvalRequests: Array<{
    title: string;
    summary: string;
    area: PermissionArea;
    targets: string[];
    reason: string;
    reversible: boolean;
    duration: 'once' | 'task' | 'workspace';
    risk: RiskLevel;
  }>;
  artifacts: Array<{
    title: string;
    kind: ArtifactRecord['kind'];
    summary: string;
    fileName?: string;
    previewContent?: string;
  }>;
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

function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('Copilot did not return valid JSON.');
}

function keywordMatch(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function grantAllows(grants: PermissionGrant[], approval: ApprovalRequest): boolean {
  return approval.targets.some((target) =>
    grants.some((grant) => grant.area === approval.area && (grant.target === target || grant.target === '*'))
  );
}

function buildStep(
  title: string,
  description: string,
  toolFamily: string,
  risk: RiskLevel,
  requiresApproval: boolean
): DraftPlan['planSteps'][number] {
  return { title, description, toolFamily, risk, requiresApproval };
}

function fallbackArtifacts(prompt: string): DraftPlan['artifacts'] {
  const lower = prompt.toLowerCase();

  if (keywordMatch(lower, ['spreadsheet', 'excel', 'csv'])) {
    return [
      {
        title: 'Spreadsheet deliverable',
        kind: 'spreadsheet',
        summary: 'Prepare a workbook structure, clean the data, and stage the output spreadsheet.',
        fileName: 'cowork-output.xlsx'
      }
    ];
  }

  if (keywordMatch(lower, ['presentation', 'deck', 'slides', 'powerpoint'])) {
    return [
      {
        title: 'Presentation draft',
        kind: 'presentation',
        summary: 'Create a slide outline with the key narrative, supporting data, and export-ready deck content.',
        fileName: 'cowork-deck.pptx'
      }
    ];
  }

  if (keywordMatch(lower, ['pdf', 'report', 'summary', 'brief'])) {
    return [
      {
        title: 'Report preview',
        kind: 'report',
        summary: 'Generate a polished written deliverable with sections, tables, and a final export path.',
        fileName: 'cowork-report.pdf'
      }
    ];
  }

  if (keywordMatch(lower, ['document', 'docx', 'word', 'memo'])) {
    return [
      {
        title: 'Document draft',
        kind: 'document',
        summary: 'Draft the document structure and prepare a formatted export.',
        fileName: 'cowork-document.docx'
      }
    ];
  }

  return [
    {
      title: 'Execution brief',
      kind: 'note',
      summary: 'Summarize the plan, dependencies, and the expected output from this cowork run.',
      fileName: 'cowork-brief.md'
    }
  ];
}

function buildFallbackPlan(input: StartRunRequest): DraftPlan {
  const prompt = input.prompt.toLowerCase();
  const approvals: DraftPlan['approvalRequests'] = [];
  const planSteps: DraftPlan['planSteps'] = [
    buildStep(
      'Frame the task',
      'Interpret the user goal, working inputs, and success criteria for this cowork run.',
      'planning',
      'safe',
      false
    )
  ];

  if (keywordMatch(prompt, ['file', 'folder', 'rename', 'move', 'organize', 'delete', 'remove', 'overwrite'])) {
    approvals.push({
      title: 'Approve local file access',
      summary: 'Allow Cowork to inspect or stage local file changes for this task.',
      area: 'files',
      targets: ['selected-files'],
      reason: 'The request involves file or folder operations on the local machine.',
      reversible: !keywordMatch(prompt, ['delete', 'remove', 'overwrite']),
      duration: 'task',
      risk: keywordMatch(prompt, ['delete', 'remove', 'overwrite']) ? 'destructive' : 'approval_required'
    });
    planSteps.push(
      buildStep(
        'Stage file operations',
        'Inspect the affected files, prepare previews, and keep any destructive changes behind explicit approval.',
        'files',
        approvals.at(-1)?.risk ?? 'approval_required',
        true
      )
    );
  }

  if (keywordMatch(prompt, ['research', 'researching', 'browse', 'website', 'web', 'sources', 'citations'])) {
    approvals.push({
      title: 'Approve web research',
      summary: 'Allow Cowork to browse the web and gather source-backed findings.',
      area: 'web',
      targets: ['browser'],
      reason: 'The task requires external information gathering and citations.',
      reversible: true,
      duration: 'task',
      risk: 'approval_required'
    });
    planSteps.push(
      buildStep(
        'Collect source material',
        'Visit relevant sources, capture citations, and normalize findings into a concise brief.',
        'web',
        'approval_required',
        true
      )
    );
  }

  if (keywordMatch(prompt, ['code', 'python', 'script', 'transform', 'clean data', 'analyze', 'analysis', 'automation'])) {
    approvals.push({
      title: 'Approve sandbox execution',
      summary: 'Allow Cowork to use an isolated code runner for data work or workflow automation.',
      area: 'sandbox',
      targets: ['sandbox-runner'],
      reason: 'The task benefits from programmatic processing in a contained environment.',
      reversible: true,
      duration: 'task',
      risk: 'approval_required'
    });
    planSteps.push(
      buildStep(
        'Prepare a sandboxed workflow',
        'Use a contained runtime for transformations, analysis, or repeatable task automation.',
        'sandbox',
        'approval_required',
        true
      )
    );
  }

  if (keywordMatch(prompt, ['gmail', 'google drive', 'notion', 'slack', 'asana'])) {
    const connectorTarget = keywordMatch(prompt, ['gmail'])
      ? 'gmail'
      : keywordMatch(prompt, ['google drive'])
        ? 'google-drive'
        : keywordMatch(prompt, ['notion'])
          ? 'notion'
          : keywordMatch(prompt, ['slack'])
            ? 'slack'
            : 'asana';

    approvals.push({
      title: `Approve ${connectorTarget} access`,
      summary: `Allow Cowork to use the ${connectorTarget} connector for this task.`,
      area: 'connectors',
      targets: [connectorTarget],
      reason: 'The request references an external system that requires scoped connector access.',
      reversible: true,
      duration: 'workspace',
      risk: 'approval_required'
    });
    planSteps.push(
      buildStep(
        'Coordinate with the connected tool',
        'Stage the connector-backed workflow and keep side effects behind explicit approval.',
        'connectors',
        'approval_required',
        true
      )
    );
  }

  if (keywordMatch(prompt, ['desktop', 'screenshot', 'click', 'type', 'open app', 'open numbers', 'open excel'])) {
    approvals.push({
      title: 'Approve desktop control',
      summary: 'Allow Cowork to inspect the screen or interact with a native desktop app.',
      area: 'desktop',
      targets: ['desktop'],
      reason: 'The task references direct interaction with the local desktop.',
      reversible: true,
      duration: 'task',
      risk: 'approval_required'
    });
    planSteps.push(
      buildStep(
        'Prepare a guided desktop action',
        'Capture the required desktop context and keep control actions visible and supervised.',
        'desktop',
        'approval_required',
        true
      )
    );
  }

  planSteps.push(
    buildStep(
      'Draft the cowork output',
      'Prepare the deliverable, recommended next steps, and any output artifacts for the user.',
      'delivery',
      'safe',
      false
    )
  );

  const attachmentSummary =
    input.attachments.length > 0
      ? `Attached context: ${input.attachments.map((attachment) => attachment.fileName).join(', ')}.`
      : 'No local attachments were provided with this task.';

  const responseMarkdown = approvals.length
    ? [
        `I broke this into ${planSteps.length} steps and identified ${approvals.length} approval gate${approvals.length > 1 ? 's' : ''}.`,
        '',
        attachmentSummary,
        '',
        'Once the required permissions are approved, I can continue with a supervised execution package and concrete deliverables.'
      ].join('\n')
    : [
        'I created a cowork execution brief for this task.',
        '',
        attachmentSummary,
        '',
        'This run can proceed without additional approvals, so the output below focuses on the deliverable, review points, and next actions.'
      ].join('\n');

  return {
    summary: `Prepared a supervised cowork plan for: ${input.prompt}`,
    responseMarkdown,
    planSteps,
    approvalRequests: approvals,
    artifacts: fallbackArtifacts(input.prompt)
  };
}

function buildFallbackContinuation(input: ResolveApprovalRequest): DraftPlan {
  return {
    summary: 'Approval recorded and the run is ready with an execution package.',
    responseMarkdown: [
      `Approval confirmed for "${input.run.approvals.find((approval) => approval.id === input.approvalId)?.title ?? 'this step'}".`,
      '',
      'Cowork has updated the run package with a supervised execution path, suggested outputs, and any remaining manual checkpoints.'
    ].join('\n'),
    planSteps: input.run.plan.map((step) => ({
      title: step.title,
      description: step.description,
      toolFamily: step.toolFamily,
      risk: step.risk,
      requiresApproval: step.requiresApproval
    })),
    approvalRequests: [],
    artifacts: input.run.artifacts.length > 0 ? input.run.artifacts : fallbackArtifacts(input.prompt)
  };
}

const CONVERSATIONAL_PATTERNS = [
  /^(hi|hello|hey|yo|hiya|howdy|greetings)\b/i,
  /^(thanks|thank you|ty|cheers|appreciate)\b/i,
  /^(good (morning|afternoon|evening|night))\b/i,
  /^(who are you|what are you|what can you (do|help)|help me understand|how do you work|what is cowork)\??$/i,
  /^(bye|goodbye|see you|see ya)\b/i,
  /^(ok|okay|cool|nice|great|awesome|got it|understood)[.! ]*$/i
];

const TASK_VERB_PATTERNS = [
  /\b(rename|move|copy|delete|remove|create|make|build|draft|write|generate|summariz|analyz|extract|convert|organize|clean|parse|fetch|download|upload|open|launch|run|execute|search|find|research|email|send|message|post|schedule|plan|outline|translate|compare|merge|split|sort|filter|count|calculate|compute|export|import|save)\b/i,
  /\.(csv|xlsx?|pdf|docx?|pptx?|txt|md|json|png|jpe?g)\b/i,
  /\bhttps?:\/\//i,
  /\b(gmail|slack|notion|google drive|asana|github|linear)\b/i
];

/**
 * Returns true when the prompt is clearly conversational (greeting, thanks,
 * meta-question) AND shows no sign of being a task request. Conservative by
 * design: when in doubt, return false so the full planning path runs.
 */
function isConversationalPrompt(input: StartRunRequest): boolean {
  if (input.attachments.length > 0) return false;

  const trimmed = input.prompt.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > 80) return false;

  if (TASK_VERB_PATTERNS.some((rx) => rx.test(trimmed))) return false;

  return CONVERSATIONAL_PATTERNS.some((rx) => rx.test(trimmed));
}

export class CopilotRuntime {
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
    try {
      return execFileSync('/usr/bin/which', ['node'], { encoding: 'utf-8' }).trim();
    } catch {
      return 'node';
    }
  }

  private resolveCopilotCliPath(): string {
    const sdkUrl = import.meta.resolve('@github/copilot/sdk');
    const sdkPath = fileURLToPath(sdkUrl);
    return path.join(path.dirname(path.dirname(sdkPath)), 'index.js');
  }

  private async getClient(): Promise<CopilotClient> {
    if (!this.client) {
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

    if (auth.modelAvailable !== true) {
      throw new AuthRequiredError(
        auth.modelAvailable === false
          ? `Selected model "${auth.model}" is not available for this account.`
          : `Could not verify model "${auth.model}" availability. Check your Copilot subscription.`
      );
    }
  }

  private normalizeDraftPlan(source: DraftPlan): DraftPlan {
    return {
      summary: normalizeText(source.summary) || 'Prepared a cowork execution plan.',
      responseMarkdown: normalizeText(source.responseMarkdown) || 'Cowork prepared a supervised execution plan for this task.',
      planSteps: (source.planSteps ?? []).map((step) => ({
        title: normalizeText(step.title) || 'Planned step',
        description: normalizeText(step.description) || 'Carry out this supervised cowork step.',
        toolFamily: normalizeText(step.toolFamily) || 'general',
        risk:
          step.risk === 'safe' || step.risk === 'approval_required' || step.risk === 'destructive'
            ? step.risk
            : 'safe',
        requiresApproval: Boolean(step.requiresApproval)
      })),
      approvalRequests: (source.approvalRequests ?? []).map((approval) => ({
        title: normalizeText(approval.title) || 'Approval required',
        summary: normalizeText(approval.summary) || 'This step requires the user to approve a sensitive action.',
        area:
          approval.area === 'files' ||
          approval.area === 'sandbox' ||
          approval.area === 'web' ||
          approval.area === 'desktop' ||
          approval.area === 'plugins' ||
          approval.area === 'connectors'
            ? approval.area
            : 'files',
        targets: Array.isArray(approval.targets) && approval.targets.length > 0 ? approval.targets : ['*'],
        reason: normalizeText(approval.reason) || 'This action needs explicit approval before Cowork continues.',
        reversible: approval.reversible !== false,
        duration:
          approval.duration === 'once' || approval.duration === 'task' || approval.duration === 'workspace'
            ? approval.duration
            : 'task',
        risk:
          approval.risk === 'safe' || approval.risk === 'approval_required' || approval.risk === 'destructive'
            ? approval.risk
            : 'approval_required'
      })),
      artifacts: (source.artifacts ?? []).map((artifact) => ({
        title: normalizeText(artifact.title) || 'Cowork artifact',
        kind:
          artifact.kind === 'report' ||
          artifact.kind === 'document' ||
          artifact.kind === 'research' ||
          artifact.kind === 'preview' ||
          artifact.kind === 'spreadsheet' ||
          artifact.kind === 'presentation' ||
          artifact.kind === 'note'
            ? artifact.kind
            : 'note',
        summary: normalizeText(artifact.summary) || 'Generated cowork output.',
        fileName: normalizeText(artifact.fileName),
        previewContent: artifact.previewContent?.trim()
      }))
    };
  }

  private buildContextLines(input: StartRunRequest | ResolveApprovalRequest): string[] {
    const recent = input.recentTaskPrompts
      .slice(-MAX_RECENT_PROMPTS)
      .map((entry, index) => `${index + 1}. ${normalizeText(entry)}`)
      .join('\n');

    const attachments = input.attachments
      .map((attachment) => {
        const summary = attachment.summary
          ? normalizeText(attachment.summary).slice(0, MAX_ATTACHMENT_SUMMARY_LENGTH)
          : 'No inline summary provided.';
        return [
          `- ${attachment.fileName}`,
          `  mime: ${attachment.mimeType || 'unknown'}`,
          `  sizeBytes: ${attachment.sizeBytes}`,
          `  summary: ${summary}`
        ].join('\n');
      })
      .join('\n');

    const grants = input.grants
      .map((grant) => `- ${grant.area}:${grant.target} (${grant.duration})`)
      .join('\n');

    return [
      `Workspace: ${input.workspaceName}`,
      `Session: ${input.sessionTitle}`,
      recent ? `Recent task prompts:\n${recent}` : 'Recent task prompts: none',
      attachments ? `Attachments:\n${attachments}` : 'Attachments: none',
      grants ? `Existing permission grants:\n${grants}` : 'Existing permission grants: none'
    ];
  }

  private async callCopilotJson<T>(prompt: string, model: string, reasoningEffort?: ReasoningEffort): Promise<T> {
    const client = await this.getClient();
    const session = await client.createSession({ model, reasoningEffort });

    try {
      const response = await session.sendAndWait({ prompt }, 60_000);
      const content = response?.data.content?.trim();
      if (!content) {
        throw new Error('Copilot returned an empty response.');
      }
      return JSON.parse(extractJsonObject(content)) as T;
    } finally {
      await session.destroy().catch(() => undefined);
    }
  }

  private async callCopilotText(prompt: string, model: string, reasoningEffort?: ReasoningEffort): Promise<string> {
    const client = await this.getClient();
    const session = await client.createSession({ model, reasoningEffort });
    try {
      const response = await session.sendAndWait({ prompt }, 30_000);
      const content = response?.data.content?.trim();
      if (!content) {
        throw new Error('Copilot returned an empty response.');
      }
      return content;
    } finally {
      await session.destroy().catch(() => undefined);
    }
  }

  private async planRun(input: StartRunRequest, model: string, reasoningEffort?: ReasoningEffort): Promise<DraftPlan> {
    const contextLines = this.buildContextLines(input).join('\n\n');
    const prompt = [
      'You are Cowork, a supervised desktop AI coworker for non-technical users.',
      'Return strict JSON only. Do not use markdown fences or extra commentary.',
      'Describe steps as planned supervised work. Never claim files were edited, apps were controlled, research was completed, or connectors were used unless explicit tool results are provided.',
      'Only request approvals when the task genuinely needs sensitive access.',
      'Schema:',
      '{"summary":"string","responseMarkdown":"string","planSteps":[{"title":"string","description":"string","toolFamily":"string","risk":"safe|approval_required|destructive","requiresApproval":true}],"approvalRequests":[{"title":"string","summary":"string","area":"files|sandbox|web|desktop|plugins|connectors","targets":["string"],"reason":"string","reversible":true,"duration":"once|task|workspace","risk":"safe|approval_required|destructive"}],"artifacts":[{"title":"string","kind":"report|document|research|preview|spreadsheet|presentation|note","summary":"string","fileName":"string","previewContent":"string"}]}',
      '',
      contextLines,
      '',
      `User goal: ${input.prompt}`
    ].join('\n');

    return this.normalizeDraftPlan(await this.callCopilotJson<DraftPlan>(prompt, model, reasoningEffort));
  }

  private async continueApprovedRun(
    input: ResolveApprovalRequest,
    model: string,
    reasoningEffort?: ReasoningEffort
  ): Promise<DraftPlan> {
    const contextLines = this.buildContextLines(input).join('\n\n');
    const approvedLabels = input.run.approvals
      .filter((approval) => approval.status === 'approved')
      .map((approval) => `${approval.title} (${approval.area})`)
      .join(', ');

    const prompt = [
      'You are Cowork, a supervised desktop AI coworker for non-technical users.',
      'The user has approved the required access for this run.',
      'Return strict JSON only. Do not use markdown fences or extra commentary.',
      'Because no raw tool outputs are being supplied here, frame the result as a staged execution package, draft deliverable, or recommended next action set. Do not claim side effects occurred.',
      'Schema:',
      '{"summary":"string","responseMarkdown":"string","planSteps":[{"title":"string","description":"string","toolFamily":"string","risk":"safe|approval_required|destructive","requiresApproval":false}],"approvalRequests":[],"artifacts":[{"title":"string","kind":"report|document|research|preview|spreadsheet|presentation|note","summary":"string","fileName":"string","previewContent":"string"}]}',
      '',
      contextLines,
      '',
      `Original task: ${input.prompt}`,
      `Approved permissions: ${approvedLabels || 'none'}`,
      `Existing run summary: ${input.run.summary}`
    ].join('\n');

    return this.normalizeDraftPlan(await this.callCopilotJson<DraftPlan>(prompt, model, reasoningEffort));
  }

  private materializePlanSteps(
    steps: DraftPlan['planSteps'],
    approvals: ApprovalRequest[],
    completeApproved = false
  ): PlanStep[] {
    return steps.map((step) => {
      const blocked = step.requiresApproval && approvals.some((approval) => approval.status === 'pending');
      return {
        id: randomUUID(),
        title: step.title,
        description: step.description,
        toolFamily: step.toolFamily,
        risk: step.risk,
        requiresApproval: step.requiresApproval,
        status: completeApproved ? 'completed' : blocked ? 'blocked' : 'pending'
      };
    });
  }

  private materializeApprovals(
    approvals: DraftPlan['approvalRequests'],
    grants: PermissionGrant[]
  ): ApprovalRequest[] {
    return approvals
      .map((approval) => ({
        id: randomUUID(),
        ...approval,
        status: 'pending' as const
      }))
      .filter((approval) => !grantAllows(grants, approval));
  }

  private materializeArtifacts(artifacts: DraftPlan['artifacts']): ArtifactRecord[] {
    return artifacts.map((artifact) => ({
      id: randomUUID(),
      title: artifact.title,
      kind: artifact.kind,
      summary: artifact.summary,
      fileName: artifact.fileName,
      previewContent: artifact.previewContent,
      createdAt: Date.now()
    }));
  }

  private async quickChatReply(input: StartRunRequest, model: string): Promise<TaskRun> {
    const startedAt = performance.now();
    const startedAtTimestamp = Date.now();

    const systemPrompt = [
      'You are Cowork, a supervised desktop AI coworker for non-technical users.',
      'The user just sent a short conversational message — a greeting, thanks, or a meta-question about what you can do.',
      'Reply in 1–3 sentences of friendly markdown. No lists, no headings, no JSON.',
      'If the user seems to be introducing themselves or asking what you do, briefly mention that you can help draft documents, organize files, summarize spreadsheets, or prepare reports — and that sensitive actions need their approval.',
      '',
      `User message: ${input.prompt.trim()}`
    ].join('\n');

    let replyMarkdown: string;
    let warning: string | undefined;

    try {
      replyMarkdown = await this.callCopilotText(systemPrompt, model, 'low');
    } catch (error) {
      replyMarkdown =
        "Hi! I'm Cowork, your supervised desktop AI coworker. Tell me what you'd like to work on — drafting a document, organizing files, summarizing data — and I'll plan the steps.";
      warning = `Copilot quick-reply failed: ${extractErrorMessage(error)}`;
    }

    const now = Date.now();
    return {
      id: randomUUID(),
      status: 'completed',
      model,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      summary: 'Quick conversational reply.',
      plan: [],
      approvals: [],
      outputBlocks: [
        {
          id: randomUUID(),
          type: 'markdown',
          title: 'Cowork response',
          content: replyMarkdown
        }
      ],
      artifacts: [],
      createdAt: startedAtTimestamp,
      startedAt: startedAtTimestamp,
      completedAt: now,
      warning
    };
  }

  async startRun(input: StartRunRequest): Promise<StartRunResponse> {
    const startedAt = performance.now();
    const startedAtTimestamp = Date.now();
    const model = resolveModel(input.model);
    const reasoningEffort = resolveReasoningEffort(input.reasoningEffort);

    await this.ensureAuthenticated(model);

    if (isConversationalPrompt(input)) {
      const run = await this.quickChatReply(input, model);
      return { run };
    }

    let draft: DraftPlan;
    let warning: string | undefined;

    try {
      draft = await this.planRun(input, model, reasoningEffort);
    } catch (error) {
      if (error instanceof AuthRequiredError) throw error;
      draft = buildFallbackPlan(input);
      warning = `Copilot planning failed: ${extractErrorMessage(error)}`;
    }

    const approvals = this.materializeApprovals(draft.approvalRequests, input.grants);
    const status = approvals.length > 0 ? 'awaiting_approval' : 'completed';
    const now = Date.now();

    const run: TaskRun = {
      id: randomUUID(),
      status,
      model,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      summary: draft.summary,
      plan: this.materializePlanSteps(draft.planSteps, approvals, status === 'completed'),
      approvals,
      outputBlocks: [
        {
          id: randomUUID(),
          type: 'markdown',
          title: 'Cowork response',
          content: draft.responseMarkdown
        },
        ...(approvals.length > 0
          ? [
              {
                id: randomUUID(),
                type: 'status' as const,
                title: 'Waiting for approval',
                content: `${approvals.length} sensitive step${approvals.length > 1 ? 's are' : ' is'} waiting for approval before Cowork continues.`
              }
            ]
          : [])
      ],
      artifacts: this.materializeArtifacts(draft.artifacts),
      createdAt: startedAtTimestamp,
      startedAt: startedAtTimestamp,
      completedAt: status === 'completed' ? now : undefined,
      warning
    };

    return { run };
  }

  async resolveApproval(input: ResolveApprovalRequest): Promise<ResolveApprovalResponse> {
    const startedAt = performance.now();
    const model = resolveModel(input.model);
    const reasoningEffort = resolveReasoningEffort(input.reasoningEffort);

    await this.ensureAuthenticated(model);

    const approvals: ApprovalRequest[] = input.run.approvals.map((approval) => {
      if (approval.id !== input.approvalId) return approval;
      return {
        ...approval,
        status: input.decision === 'approve' ? 'approved' : 'denied'
      };
    });

    if (input.decision === 'deny') {
      return {
        run: {
          ...input.run,
          status: 'blocked',
          approvals,
          completedAt: Date.now(),
          latencyMs: Number((performance.now() - startedAt).toFixed(2)),
          outputBlocks: [
            ...input.run.outputBlocks,
            {
              id: randomUUID(),
              type: 'warning',
              title: 'Approval denied',
              content: 'Cowork paused this run because a required permission was denied.'
            }
          ]
        }
      };
    }

    const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');
    if (pendingApprovals.length > 0) {
      return {
        run: {
          ...input.run,
          status: 'awaiting_approval',
          approvals,
          latencyMs: Number((performance.now() - startedAt).toFixed(2)),
          outputBlocks: [
            ...input.run.outputBlocks,
            {
              id: randomUUID(),
              type: 'status',
              title: 'Approval recorded',
              content: 'Cowork saved this approval and is still waiting on additional permissions.'
            }
          ]
        }
      };
    }

    let continuation: DraftPlan;
    let warning: string | undefined;

    try {
      continuation = await this.continueApprovedRun(
        { ...input, run: { ...input.run, approvals } },
        model,
        reasoningEffort
      );
    } catch (error) {
      if (error instanceof AuthRequiredError) throw error;
      continuation = buildFallbackContinuation({ ...input, run: { ...input.run, approvals } });
      warning = `Copilot continuation failed: ${extractErrorMessage(error)}`;
    }

    return {
      run: {
        ...input.run,
        status: 'completed',
        approvals,
        summary: continuation.summary,
        plan: this.materializePlanSteps(continuation.planSteps, approvals, true),
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        completedAt: Date.now(),
        artifacts: this.materializeArtifacts(continuation.artifacts),
        warning,
        outputBlocks: [
          ...input.run.outputBlocks.filter((block) => block.type !== 'status'),
          {
            id: randomUUID(),
            type: 'status',
            title: 'Approval recorded',
            content: 'Cowork received the required approvals and refreshed the execution package.'
          },
          {
            id: randomUUID(),
            type: 'markdown',
            title: 'Updated run package',
            content: continuation.responseMarkdown
          }
        ]
      }
    };
  }
}
