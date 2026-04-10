import './styles.css';

import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import 'highlight.js/styles/github.css';
import { marked } from 'marked';
import type {
  AppSettings,
  AppState,
  ApprovalRequest,
  AttachmentRecord,
  PermissionGrant,
  ResolveApprovalResponse,
  SessionRecord,
  StartRunResponse,
  TaskRecord,
  TaskRun,
  WorkspaceMetadata
} from '../shared/contracts.js';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('plaintext', plaintext);

type DocumentPilotApi = Window['documentPilot'];

interface ShortcutDefinition {
  key: string;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

interface AuthGateState {
  checking: boolean;
  status: Awaited<ReturnType<DocumentPilotApi['getCopilotAuthStatus']>> | null;
}

const LEGACY_STORAGE_KEY = 'document-pilot.ui.v1';
const DEFAULT_SETTINGS: AppSettings = {
  model: 'gpt-5-mini',
  reasoningEffort: 'high',
  shortcuts: {
    sendMessage: 'Meta+Enter',
    newSession: 'Meta+Shift+N'
  }
};

const fileInput = requireElement<HTMLInputElement>('#file-input');
const attachFileButton = requireElement<HTMLButtonElement>('#attach-file');
const addAttachmentButton = requireElement<HTMLButtonElement>('#add-attachment');
const promptInput = requireElement<HTMLTextAreaElement>('#prompt');
const sendButton = requireElement<HTMLButtonElement>('#send');
const statusEl = requireElement<HTMLSpanElement>('#status');
const metricsEl = requireElement<HTMLDivElement>('#metrics');
const fileChipEl = requireElement<HTMLSpanElement>('#file-chip');
const sessionTitleEl = requireElement<HTMLHeadingElement>('#session-title');
const sessionSubtitleEl = requireElement<HTMLParagraphElement>('#session-subtitle');
const runtimeIndicatorEl = requireElement<HTMLDivElement>('#runtime-indicator');
const grantIndicatorEl = requireElement<HTMLDivElement>('#grant-indicator');
const modelChipEl = requireElement<HTMLSpanElement>('#model-chip');
const reasoningChipEl = requireElement<HTMLSpanElement>('#reasoning-chip');
const workspaceListEl = requireElement<HTMLDivElement>('#workspace-list');
const sessionListEl = requireElement<HTMLDivElement>('#session-list');
const newWorkspaceButton = requireElement<HTMLButtonElement>('#new-workspace');
const newSessionButton = requireElement<HTMLButtonElement>('#new-session');
const openSettingsButton = requireElement<HTMLButtonElement>('#open-settings');
const taskFeedEl = requireElement<HTMLDivElement>('#task-feed');
const authGateEl = requireElement<HTMLElement>('#auth-gate');
const authMessageEl = requireElement<HTMLParagraphElement>('#auth-message');
const recheckAuthButton = requireElement<HTMLButtonElement>('#recheck-auth');
const attachmentBarEl = requireElement<HTMLDivElement>('#attachment-bar');
const attachmentChipsEl = requireElement<HTMLDivElement>('#attachment-chips');
const settingsModalEl = requireElement<HTMLDivElement>('#settings-modal');
const closeSettingsButton = requireElement<HTMLButtonElement>('#close-settings');
const saveSettingsButton = requireElement<HTMLButtonElement>('#save-settings');
const settingsModelInput = requireElement<HTMLInputElement>('#settings-model');
const settingsReasoningSelect = requireElement<HTMLSelectElement>('#settings-reasoning');
const shortcutSendInput = requireElement<HTMLInputElement>('#shortcut-send');
const shortcutNewSessionInput = requireElement<HTMLInputElement>('#shortcut-new-session');
const confirmModalEl = requireElement<HTMLDivElement>('#confirm-modal');
const confirmMessageEl = requireElement<HTMLParagraphElement>('#confirm-message');
const confirmCancelButton = requireElement<HTMLButtonElement>('#confirm-cancel');
const confirmOkButton = requireElement<HTMLButtonElement>('#confirm-ok');

let appState: AppState | null = null;
let activeWorkspace: WorkspaceMetadata | null = null;
let authGateState: AuthGateState = { checking: true, status: null };
let desktopApiCache: Partial<DocumentPilotApi> | null = null;
let pendingConfirm: { resolve: (ok: boolean) => void } | null = null;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const renderer = new marked.Renderer();

renderer.code = function ({ text, lang }) {
  const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
  const highlighted = hljs.highlight(text, { language }).value;
  const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
  return `<div class="code-block">${langLabel}<pre><code class="hljs language-${escapeHtml(language)}">${highlighted}</code></pre></div>`;
};

renderer.link = function ({ href, title, text }) {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

marked.use({
  renderer,
  gfm: true,
  breaks: true,
  hooks: {
    postprocess(html) {
      return html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
    }
  }
});

function renderMarkdown(content: string): string {
  const rawHtml = marked.parse(content) as string;
  return DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target'] });
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function truncate(value: string, max = 80): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function formatStatusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

async function resolveDesktopApi(timeoutMs = 1500): Promise<Partial<DocumentPilotApi> | null> {
  if (desktopApiCache) return desktopApiCache;
  const startedAt = performance.now();
  while (performance.now() - startedAt <= timeoutMs) {
    const candidate = (window as Window & { documentPilot?: Partial<DocumentPilotApi> }).documentPilot;
    if (candidate) {
      desktopApiCache = candidate;
      return candidate;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
  }
  return null;
}

function showConfirm(message: string): Promise<boolean> {
  confirmMessageEl.textContent = message;
  confirmModalEl.classList.remove('hidden');
  return new Promise((resolve) => {
    pendingConfirm = { resolve };
  });
}

function closeConfirm(result: boolean): void {
  confirmModalEl.classList.add('hidden');
  if (!pendingConfirm) return;
  pendingConfirm.resolve(result);
  pendingConfirm = null;
}

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function setMetrics(message: string): void {
  metricsEl.textContent = message;
}

function getSettings(): AppSettings {
  return appState?.settings ?? DEFAULT_SETTINGS;
}

function getAuthBlockReason(status: AuthGateState['status']): string | null {
  if (!status) return 'Checking GitHub authentication...';
  if (!status.ok) return `Copilot SDK unavailable: ${status.statusMessage}`;
  if (!status.isAuthenticated) return status.statusMessage;
  if (status.modelAvailable === false) return `Model "${status.model}" is not available for this account.`;
  return null;
}

function applyAuthGate(): void {
  const reason = authGateState.checking ? 'Checking GitHub authentication...' : getAuthBlockReason(authGateState.status);
  const locked = authGateState.checking || Boolean(reason);
  sendButton.disabled = locked;
  promptInput.disabled = locked;
  if (locked) {
    authGateEl.classList.remove('hidden');
    authMessageEl.textContent = reason ?? 'Authentication required.';
  } else {
    authGateEl.classList.add('hidden');
  }
  recheckAuthButton.disabled = authGateState.checking;
}

async function refreshAuthStatus(announceSuccess = false): Promise<boolean> {
  const settings = getSettings();
  authGateState = { checking: true, status: authGateState.status };
  applyAuthGate();

  const api = await resolveDesktopApi();
  if (!api) {
    authGateState = {
      checking: false,
      status: {
        ok: false,
        isAuthenticated: false,
        statusMessage: 'Desktop bridge unavailable. Restart the app to reload the preload script.',
        model: settings.model,
        checkedAt: Date.now()
      }
    };
    applyAuthGate();
    setStatus(authGateState.status?.statusMessage ?? 'Desktop bridge unavailable.');
    return false;
  }

  if (typeof api.getCopilotAuthStatus !== 'function') {
    authGateState = {
      checking: false,
      status: {
        ok: true,
        isAuthenticated: true,
        statusMessage: 'Auth precheck unavailable in this runtime. Continuing and validating on send.',
        model: settings.model,
        checkedAt: Date.now()
      }
    };
    applyAuthGate();
    if (announceSuccess) setStatus('Bridge compatibility mode: auth will be validated when you delegate a task.');
    return true;
  }

  try {
    const status = await api.getCopilotAuthStatus({ model: settings.model });
    authGateState = { checking: false, status };
  } catch (error) {
    authGateState = {
      checking: false,
      status: {
        ok: false,
        isAuthenticated: false,
        statusMessage: (error as Error).message || 'Unable to check Copilot authentication.',
        model: settings.model,
        checkedAt: Date.now()
      }
    };
  }

  applyAuthGate();
  const reason = getAuthBlockReason(authGateState.status);
  if (!reason) {
    if (announceSuccess) setStatus(`Authenticated as ${authGateState.status?.login ?? 'user'}.`);
    return true;
  }
  setStatus(reason);
  return false;
}

async function ensureAuthReady(): Promise<boolean> {
  if (authGateState.checking) return false;
  if (!getAuthBlockReason(authGateState.status)) return true;
  return refreshAuthStatus(false);
}

function parseShortcut(value: string): ShortcutDefinition | null {
  const parts = value
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  if (parts.length === 0) return null;

  const key = parts.find((part) => !['meta', 'cmd', 'command', 'shift', 'alt', 'option', 'ctrl', 'control'].includes(part));
  if (!key) return null;

  return {
    key: key === 'return' ? 'enter' : key,
    meta: parts.includes('meta') || parts.includes('cmd') || parts.includes('command'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt') || parts.includes('option'),
    ctrl: parts.includes('ctrl') || parts.includes('control')
  };
}

function shortcutMatches(event: KeyboardEvent, binding: string): boolean {
  const shortcut = parseShortcut(binding);
  if (!shortcut) return false;
  const normalizedKey = event.key.toLowerCase() === 'return' ? 'enter' : event.key.toLowerCase();
  return (
    normalizedKey === shortcut.key &&
    event.metaKey === shortcut.meta &&
    event.shiftKey === shortcut.shift &&
    event.altKey === shortcut.alt &&
    event.ctrlKey === shortcut.ctrl
  );
}

function getActiveSession(): SessionRecord | null {
  if (!activeWorkspace || !appState?.activeSessionId) return null;
  const activeSessionId = appState.activeSessionId;
  return activeWorkspace.sessions.find((session) => session.id === activeSessionId) ?? null;
}

function syncWorkspaceIndex(workspace: WorkspaceMetadata): void {
  if (!appState) return;
  const existing = appState.workspaceIndex.find((entry) => entry.id === workspace.id);
  if (existing) {
    existing.name = workspace.name;
    existing.updatedAt = workspace.updatedAt;
  } else {
    appState.workspaceIndex.unshift({ id: workspace.id, name: workspace.name, updatedAt: workspace.updatedAt });
  }
}

async function saveAppState(): Promise<void> {
  if (!appState) return;
  const api = await resolveDesktopApi();
  if (api?.saveAppState) {
    api.saveAppState({ state: appState }).catch((error) => {
      console.error('[cowork] saveAppState failed:', error);
    });
  }
}

async function saveActiveWorkspace(): Promise<void> {
  if (!activeWorkspace) return;
  const api = await resolveDesktopApi();
  if (api?.saveWorkspace) {
    api.saveWorkspace({ workspace: activeWorkspace }).catch((error) => {
      console.error('[cowork] saveWorkspace failed:', error);
    });
  }
}

function saveAll(): void {
  void saveAppState();
  void saveActiveWorkspace();
}

function workspaceGrantExists(workspace: WorkspaceMetadata, approval: ApprovalRequest): boolean {
  return approval.targets.some((target) =>
    workspace.permissionGrants.some((grant) => grant.area === approval.area && grant.target === target)
  );
}

function registerWorkspaceGrant(workspace: WorkspaceMetadata, approval: ApprovalRequest): void {
  if (approval.duration !== 'workspace' || workspaceGrantExists(workspace, approval)) return;
  for (const target of approval.targets) {
    workspace.permissionGrants.push({
      id: uid('grant'),
      area: approval.area,
      target,
      duration: 'workspace',
      grantedAt: Date.now(),
      note: approval.title
    });
  }
}

function updateRuntimeChips(): void {
  const settings = getSettings();
  modelChipEl.textContent = `Model: ${settings.model}`;
  reasoningChipEl.textContent = `Reasoning: ${settings.reasoningEffort}`;
  runtimeIndicatorEl.textContent = `Model: ${settings.model} | Reasoning: ${settings.reasoningEffort}`;
  grantIndicatorEl.textContent = `${activeWorkspace?.permissionGrants.length ?? 0} grants`;
}

function updateFileChip(): void {
  const attachments = getActiveSession()?.attachments ?? [];
  if (attachments.length === 0) {
    fileChipEl.textContent = 'No attachments';
    return;
  }
  if (attachments.length === 1) {
    fileChipEl.textContent = attachments[0].originalFileName;
    return;
  }
  fileChipEl.textContent = `${attachments.length} attachments`;
}

function renderWorkspaceList(): void {
  if (!appState) return;
  const activeWorkspaceId = appState.activeWorkspaceId;

  workspaceListEl.innerHTML = appState.workspaceIndex
    .map((workspace) => {
      const active = activeWorkspaceId === workspace.id;
      return [
        `<div class="workspace-card ${active ? 'active' : ''}">`,
        '<div class="workspace-headline">',
        `<button class="workspace-title-btn" data-action="switch-workspace" data-workspace-id="${workspace.id}">`,
        `<strong>${escapeHtml(workspace.name)}</strong>`,
        `<span>Updated ${formatRelativeTime(workspace.updatedAt)}</span>`,
        '</button>',
        '<div class="workspace-tools">',
        `<button class="icon-btn" type="button" data-action="delete-workspace" data-workspace-id="${workspace.id}" aria-label="Delete workspace">&times;</button>`,
        '</div>',
        '</div>',
        '</div>'
      ].join('');
    })
    .join('');
}

function renderSessionList(): void {
  if (!activeWorkspace) {
    sessionListEl.innerHTML = '';
    return;
  }

  sessionListEl.innerHTML = activeWorkspace.sessions
    .map((session) => {
      const active = appState?.activeSessionId === session.id;
      return [
        `<div class="session-btn-row ${active ? 'active' : ''}">`,
        `<button class="session-btn" type="button" data-action="switch-session" data-session-id="${session.id}">`,
        `<strong>${escapeHtml(session.title)}</strong>`,
        `<span>${session.tasks.length} tasks • ${formatRelativeTime(session.lastUpdated)}</span>`,
        '</button>',
        '<div class="session-tools">',
        `<button class="icon-btn" type="button" data-action="delete-session" data-session-id="${session.id}" aria-label="Delete session">&times;</button>`,
        '</div>',
        '</div>'
      ].join('');
    })
    .join('');
}

function renderAttachmentBar(): void {
  const session = getActiveSession();
  const attachments = session?.attachments ?? [];

  if (attachments.length === 0) {
    attachmentBarEl.classList.add('hidden');
    attachmentChipsEl.innerHTML = '';
    return;
  }

  attachmentBarEl.classList.remove('hidden');
  attachmentChipsEl.innerHTML = attachments
    .map((attachment) => {
      const title = attachment.summary ? ` title="${escapeHtml(truncate(attachment.summary, 160))}"` : '';
      return [
        `<span class="attachment-chip"${title}>`,
        escapeHtml(attachment.originalFileName),
        `<button type="button" data-action="remove-attachment" data-attachment-id="${attachment.id}" data-stored-file="${escapeHtml(attachment.storedFileName)}" aria-label="Remove attachment">&times;</button>`,
        '</span>'
      ].join('');
    })
    .join('');
}

function renderOutputBlock(run: TaskRun): string {
  if (run.outputBlocks.length === 0) return '';
  return [
    '<section class="output-panel">',
    '<h4>Run Output</h4>',
    '<div class="output-grid">',
    run.outputBlocks
      .map((block) => {
        const title = block.title ? `<div class="output-block-title">${escapeHtml(block.title)}</div>` : '';
        const body =
          block.type === 'markdown'
            ? renderMarkdown(block.content)
            : `<p>${escapeHtml(block.content)}</p>`;
        return `<article class="output-block ${block.type}">${title}${body}</article>`;
      })
      .join(''),
    '</div>',
    '</section>'
  ].join('');
}

function renderPlan(run: TaskRun): string {
  if (run.plan.length === 0) return '';
  return [
    '<section class="plan-panel">',
    '<h4>Planned Workflow</h4>',
    '<div class="plan-list">',
    run.plan
      .map(
        (step, index) => `
          <article class="plan-step">
            <div class="plan-step-head">
              <div class="plan-step-title">
                <span class="step-num ${step.status}">${index + 1}</span>
                <strong>${escapeHtml(step.title)}</strong>
              </div>
              <span class="status-pill ${step.status}">${escapeHtml(formatStatusLabel(step.status))}</span>
            </div>
            <p>${escapeHtml(step.description)}</p>
            <div class="step-tags">
              <span class="tag">${escapeHtml(step.toolFamily)}</span>
              <span class="tag">${escapeHtml(step.risk)}</span>
              ${step.requiresApproval ? '<span class="tag">approval gate</span>' : ''}
            </div>
          </article>
        `
      )
      .join(''),
    '</div>',
    '</section>'
  ].join('');
}

function renderApprovals(task: TaskRecord, run: TaskRun): string {
  if (run.approvals.length === 0) return '';

  return [
    '<section class="approval-panel">',
    '<h4>Approval Checkpoints</h4>',
    '<div class="approval-grid">',
    run.approvals
      .map((approval) => {
        const targets = approval.targets.length > 0 ? approval.targets.map((target) => `<li>${escapeHtml(target)}</li>`).join('') : '<li>General scope</li>';
        const actions =
          approval.status === 'pending'
            ? `
              <div class="approval-actions">
                <button class="primary" type="button" data-action="resolve-approval" data-task-id="${task.id}" data-approval-id="${approval.id}" data-decision="approve">Approve</button>
                <button class="ghost" type="button" data-action="resolve-approval" data-task-id="${task.id}" data-approval-id="${approval.id}" data-decision="deny">Deny</button>
              </div>
            `
            : `<span class="approval-state ${approval.status}">${escapeHtml(approval.status)}</span>`;

        return `
          <article class="approval-card ${approval.status}">
            <div class="plan-step-head">
              <strong>${escapeHtml(approval.title)}</strong>
              <span class="approval-state ${approval.status}">${escapeHtml(approval.status)}</span>
            </div>
            <p>${escapeHtml(approval.summary)}</p>
            <ul>${targets}</ul>
            <p><strong>Why:</strong> ${escapeHtml(approval.reason)}</p>
            <p><strong>Scope:</strong> ${escapeHtml(approval.area)} • ${escapeHtml(approval.duration)} • ${approval.reversible ? 'reversible where possible' : 'not easily reversible'}</p>
            ${actions}
          </article>
        `;
      })
      .join(''),
    '</div>',
    '</section>'
  ].join('');
}

function renderArtifacts(run: TaskRun): string {
  if (run.artifacts.length === 0) return '';
  return [
    '<section class="artifact-panel">',
    '<h4>Artifacts</h4>',
    '<div class="artifact-grid">',
    run.artifacts
      .map((artifact) => {
        const fileName = artifact.fileName ? `<span class="tag">${escapeHtml(artifact.fileName)}</span>` : '';
        const preview = artifact.previewContent ? `<pre>${escapeHtml(artifact.previewContent)}</pre>` : '';
        return `
          <article class="artifact-card">
            <strong>${escapeHtml(artifact.title)}</strong>
            <div class="step-tags">
              <span class="tag">${escapeHtml(artifact.kind)}</span>
              ${fileName}
            </div>
            <p>${escapeHtml(artifact.summary)}</p>
            ${preview}
          </article>
        `;
      })
      .join(''),
    '</div>',
    '</section>'
  ].join('');
}

function renderTaskCard(task: TaskRecord): string {
  const latestRun = task.runs.at(-1);
  const metaLine = latestRun
    ? `${latestRun.model} • ${latestRun.latencyMs}ms • ${formatRelativeTime(task.updatedAt)}`
    : `Created ${formatRelativeTime(task.createdAt)}`;
  const summary = latestRun?.summary
    ? `<section class="summary-panel"><h4>Run Summary</h4><p>${escapeHtml(latestRun.summary)}</p></section>`
    : '';

  return [
    '<article class="task-card">',
    '<header class="task-header">',
    `<div class="task-prompt">${escapeHtml(task.prompt)}</div>`,
    '<div class="task-meta">',
    latestRun ? `<span class="status-pill ${latestRun.status}">${escapeHtml(formatStatusLabel(latestRun.status))}</span>` : '',
    `<span class="meta-note">${escapeHtml(metaLine)}</span>`,
    '</div>',
    '</header>',
    summary,
    latestRun ? renderPlan(latestRun) : '',
    latestRun ? renderApprovals(task, latestRun) : '',
    latestRun ? renderOutputBlock(latestRun) : '',
    latestRun ? renderArtifacts(latestRun) : '',
    latestRun?.warning
      ? `<section class="output-panel"><div class="output-grid"><article class="output-block warning"><div class="output-block-title">Warning</div><p>${escapeHtml(latestRun.warning)}</p></article></div></section>`
      : '',
    '</article>'
  ].join('');
}

function renderTaskFeed(): void {
  const session = getActiveSession();
  if (!session || session.tasks.length === 0) {
    taskFeedEl.innerHTML = [
      '<section class="empty-state">',
      '<h3>Delegate real work in plain English</h3>',
      '<p>Cowork plans multi-step tasks, stages sensitive actions behind approvals, and keeps every run visible and reviewable.</p>',
      '<div class="hint-list">',
      '<div class="hint-pill">“Create a weekly operations brief from these CSV exports and stage a PDF plus deck.”</div>',
      '<div class="hint-pill">“Research three competitors, cite sources, and draft a comparison memo.”</div>',
      '<div class="hint-pill">“Organize the invoices in this folder, but show me the rename plan before anything destructive.”</div>',
      '</div>',
      '</section>'
    ].join('');
    return;
  }

  taskFeedEl.innerHTML = session.tasks
    .slice()
    .reverse()
    .map((task) => renderTaskCard(task))
    .join('');

  scrollToPendingApproval();
}

function scrollToPendingApproval(): void {
  const card = taskFeedEl.querySelector<HTMLElement>('.approval-card.pending');
  if (!card) return;
  const feedRect = taskFeedEl.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const isVisible = cardRect.top >= feedRect.top && cardRect.bottom <= feedRect.bottom;
  if (!isVisible) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function applyContext(): void {
  const session = getActiveSession();
  if (activeWorkspace && session) {
    sessionTitleEl.textContent = session.title;
    sessionSubtitleEl.textContent = `${activeWorkspace.name} • ${session.tasks.length} tasks • ${session.attachments.length} files • ${activeWorkspace.permissionGrants.length} grants`;
  } else if (activeWorkspace) {
    sessionTitleEl.textContent = activeWorkspace.name;
    sessionSubtitleEl.textContent = 'Choose a session to continue.';
  } else {
    sessionTitleEl.textContent = 'Cowork';
    sessionSubtitleEl.textContent = 'Create a workspace to start delegating tasks.';
  }

  updateRuntimeChips();
  updateFileChip();
  renderWorkspaceList();
  renderSessionList();
  renderAttachmentBar();
  renderTaskFeed();
}

function createDefaultWorkspace(name = 'Cowork Workspace'): WorkspaceMetadata {
  const now = Date.now();
  return {
    id: uid('workspace'),
    name,
    sessions: [
      {
        id: uid('session'),
        title: 'General',
        tasks: [],
        attachments: [],
        lastUpdated: now
      }
    ],
    permissionGrants: [],
    createdAt: now,
    updatedAt: now
  };
}

async function switchToWorkspace(workspaceId: string): Promise<void> {
  if (!appState) return;
  const api = await resolveDesktopApi();
  if (!api?.loadWorkspace) return;

  setStatus('Loading workspace...');
  const { workspace } = await api.loadWorkspace({ workspaceId });
  if (!workspace) {
    setStatus('Workspace not found on disk.');
    return;
  }

  activeWorkspace = workspace;
  appState.activeWorkspaceId = workspaceId;
  const currentActiveSessionId = appState.activeSessionId;
  appState.activeSessionId =
    currentActiveSessionId && workspace.sessions.some((session) => session.id === currentActiveSessionId)
      ? currentActiveSessionId
      : workspace.sessions[0]?.id ?? null;

  void saveAppState();
  applyContext();
  setStatus('Ready.');
}

function switchSession(sessionId: string): void {
  if (!appState || !activeWorkspace) return;
  if (!activeWorkspace.sessions.some((session) => session.id === sessionId)) return;
  appState.activeSessionId = sessionId;
  void saveAppState();
  applyContext();
}

async function createWorkspace(): Promise<void> {
  const name = window.prompt('Workspace name', 'New Workspace')?.trim();
  if (!name || !appState) return;

  activeWorkspace = createDefaultWorkspace(name);
  syncWorkspaceIndex(activeWorkspace);
  appState.activeWorkspaceId = activeWorkspace.id;
  appState.activeSessionId = activeWorkspace.sessions[0]?.id ?? null;

  saveAll();
  applyContext();
  setStatus(`Created workspace "${name}".`);
}

function createSession(workspaceId: string): void {
  if (!appState || !activeWorkspace || activeWorkspace.id !== workspaceId) return;
  const now = Date.now();
  const session: SessionRecord = {
    id: uid('session'),
    title: 'New Session',
    tasks: [],
    attachments: [],
    lastUpdated: now
  };

  activeWorkspace.sessions.unshift(session);
  activeWorkspace.updatedAt = now;
  syncWorkspaceIndex(activeWorkspace);
  appState.activeSessionId = session.id;
  saveAll();
  applyContext();
  setStatus('New session created.');
}

async function deleteWorkspace(workspaceId: string): Promise<void> {
  if (!appState) return;
  const entry = appState.workspaceIndex.find((workspace) => workspace.id === workspaceId);
  if (!entry) return;

  const confirmed = await showConfirm(`Delete workspace "${entry.name}" and all of its sessions?`);
  if (!confirmed) return;

  const api = await resolveDesktopApi();
  if (api?.deleteWorkspace) {
    await api.deleteWorkspace({ workspaceId }).catch(() => undefined);
  }

  appState.workspaceIndex = appState.workspaceIndex.filter((workspace) => workspace.id !== workspaceId);

  if (appState.workspaceIndex.length === 0) {
    activeWorkspace = createDefaultWorkspace();
    syncWorkspaceIndex(activeWorkspace);
    appState.activeWorkspaceId = activeWorkspace.id;
    appState.activeSessionId = activeWorkspace.sessions[0]?.id ?? null;
    saveAll();
    applyContext();
    return;
  }

  if (appState.activeWorkspaceId === workspaceId) {
    await switchToWorkspace(appState.workspaceIndex[0].id);
  } else {
    void saveAppState();
    renderWorkspaceList();
  }
}

async function deleteSession(sessionId: string): Promise<void> {
  if (!activeWorkspace || !appState) return;
  const session = activeWorkspace.sessions.find((entry) => entry.id === sessionId);
  if (!session) return;
  if (activeWorkspace.sessions.length <= 1) {
    setStatus('A workspace needs at least one session.');
    return;
  }

  const confirmed = await showConfirm(`Delete session "${session.title}" and its task history?`);
  if (!confirmed) return;

  for (const attachment of session.attachments) {
    const api = await resolveDesktopApi();
    if (api?.deleteAttachment) {
      await api
        .deleteAttachment({ targetId: session.id, attachmentId: attachment.id, storedFileName: attachment.storedFileName })
        .catch(() => undefined);
    }
  }

  activeWorkspace.sessions = activeWorkspace.sessions.filter((entry) => entry.id !== sessionId);
  activeWorkspace.updatedAt = Date.now();
  syncWorkspaceIndex(activeWorkspace);

  if (appState.activeSessionId === sessionId) {
    appState.activeSessionId = activeWorkspace.sessions[0]?.id ?? null;
  }

  saveAll();
  applyContext();
}

function isTextLike(file: File): boolean {
  const lower = file.name.toLowerCase();
  return (
    file.type.startsWith('text/') ||
    file.type.includes('json') ||
    file.type.includes('csv') ||
    lower.endsWith('.md') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.json') ||
    lower.endsWith('.csv') ||
    lower.endsWith('.log')
  );
}

async function buildAttachmentSummary(file: File): Promise<string> {
  if (isTextLike(file)) {
    const text = await file.text();
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return 'Text attachment with no readable content.';
    return truncate(normalized, 400);
  }

  if (file.type.startsWith('image/')) {
    return `Image attachment (${file.type || 'unknown format'}, ${Math.round(file.size / 1024)} KB).`;
  }

  return `Binary attachment (${file.type || 'unknown format'}, ${Math.round(file.size / 1024)} KB).`;
}

async function attachFilesToCurrentSession(files: FileList | null): Promise<void> {
  if (!files || files.length === 0 || !activeWorkspace) return;
  const session = getActiveSession();
  if (!session) {
    setStatus('Create a session before adding files.');
    return;
  }

  const api = await resolveDesktopApi();
  if (!api?.copyAttachment) {
    setStatus('Desktop bridge unavailable.');
    return;
  }

  setStatus(`Saving ${files.length} attachment${files.length > 1 ? 's' : ''}...`);

  for (const file of Array.from(files)) {
    const attachmentId = uid('attachment');
    const fileData = await file.arrayBuffer();
    const summary = await buildAttachmentSummary(file);
    const { attachment } = await api.copyAttachment({
      targetId: session.id,
      attachmentId,
      originalFileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      fileData
    });
    session.attachments.unshift({ ...attachment, summary });
  }

  session.lastUpdated = Date.now();
  activeWorkspace.updatedAt = Date.now();
  syncWorkspaceIndex(activeWorkspace);
  saveAll();
  applyContext();
  setStatus('Attachments added.');
}

async function removeAttachment(attachmentId: string, storedFileName: string): Promise<void> {
  const session = getActiveSession();
  const api = await resolveDesktopApi();
  if (!session || !api?.deleteAttachment) return;

  await api
    .deleteAttachment({ targetId: session.id, attachmentId, storedFileName })
    .catch(() => undefined);

  session.attachments = session.attachments.filter((attachment) => attachment.id !== attachmentId);
  session.lastUpdated = Date.now();
  if (activeWorkspace) {
    activeWorkspace.updatedAt = Date.now();
    syncWorkspaceIndex(activeWorkspace);
  }
  saveAll();
  applyContext();
}

function createDraftingRun(model: string): TaskRun {
  const now = Date.now();
  return {
    id: uid('run'),
    status: 'drafting_plan',
    model,
    latencyMs: 0,
    summary: 'Cowork is drafting a supervised execution plan.',
    plan: [],
    approvals: [],
    outputBlocks: [
      {
        id: uid('block'),
        type: 'status',
        title: 'Drafting plan',
        content: 'Analyzing the task, checking the active context, and deciding whether any approvals are required.'
      }
    ],
    artifacts: [],
    createdAt: now,
    startedAt: now
  };
}

function createFailedRun(model: string, message: string): TaskRun {
  const now = Date.now();
  return {
    id: uid('run'),
    status: 'failed',
    model,
    latencyMs: 0,
    summary: 'The cowork run failed before execution could start.',
    plan: [],
    approvals: [],
    outputBlocks: [
      {
        id: uid('block'),
        type: 'warning',
        title: 'Run failed',
        content: message
      }
    ],
    artifacts: [],
    createdAt: now,
    startedAt: now,
    completedAt: now
  };
}

function taskContextPrompts(session: SessionRecord, excludeTaskId?: string): string[] {
  return session.tasks
    .filter((task) => task.id !== excludeTaskId)
    .slice(-6)
    .map((task) => task.prompt);
}

function serializeAttachments(session: SessionRecord) {
  return session.attachments.map((attachment) => ({
    id: attachment.id,
    fileName: attachment.originalFileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    summary: attachment.summary
  }));
}

async function sendPrompt(): Promise<void> {
  if (!(await ensureAuthReady())) return;
  if (!activeWorkspace) return;

  const session = getActiveSession();
  if (!session) {
    setStatus('Select a session first.');
    return;
  }

  const prompt = promptInput.value.trim();
  if (!prompt) {
    setStatus('Enter a task first.');
    return;
  }

  const api = await resolveDesktopApi();
  if (!api?.startRun) {
    setStatus('Desktop bridge unavailable. Restart the app and try again.');
    return;
  }

  const settings = getSettings();
  const now = Date.now();
  const task: TaskRecord = {
    id: uid('task'),
    prompt,
    createdAt: now,
    updatedAt: now,
    runs: [createDraftingRun(settings.model)]
  };

  if (session.title === 'New Session' || session.title === 'General') {
    session.title = truncate(prompt, 46);
  }

  session.tasks.push(task);
  session.lastUpdated = now;
  activeWorkspace.updatedAt = now;
  syncWorkspaceIndex(activeWorkspace);
  promptInput.value = '';
  promptInput.style.height = 'auto';
  saveAll();
  applyContext();

  sendButton.disabled = true;
  promptInput.disabled = true;
  setStatus('Cowork is drafting the run...');

  try {
    const startedAt = performance.now();
    const response: StartRunResponse = await api.startRun({
      prompt,
      workspaceName: activeWorkspace.name,
      sessionTitle: session.title,
      recentTaskPrompts: taskContextPrompts(session, task.id),
      attachments: serializeAttachments(session),
      grants: activeWorkspace.permissionGrants,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort
    });

    task.runs = [response.run];
    task.updatedAt = Date.now();
    session.lastUpdated = Date.now();
    activeWorkspace.updatedAt = Date.now();
    syncWorkspaceIndex(activeWorkspace);
    saveAll();
    applyContext();

    const totalMs = Number((performance.now() - startedAt).toFixed(2));
    setMetrics(
      `${session.attachments.length} files • ${response.run.latencyMs}ms run • ${totalMs}ms total`
    );
    setStatus(response.run.status === 'awaiting_approval' ? 'Run is waiting for approval.' : 'Run ready.');
  } catch (error) {
    task.runs = [createFailedRun(settings.model, (error as Error).message)];
    task.updatedAt = Date.now();
    session.lastUpdated = Date.now();
    activeWorkspace.updatedAt = Date.now();
    syncWorkspaceIndex(activeWorkspace);
    saveAll();
    applyContext();
    setStatus(`Run failed: ${(error as Error).message}`);
  } finally {
    sendButton.disabled = false;
    promptInput.disabled = false;
    promptInput.focus();
  }
}

async function resolveApproval(taskId: string, approvalId: string, decision: 'approve' | 'deny'): Promise<void> {
  if (!(await ensureAuthReady()) || !activeWorkspace) return;

  const session = getActiveSession();
  const task = session?.tasks.find((entry) => entry.id === taskId);
  const run = task?.runs.at(-1);
  if (!session || !task || !run) return;

  const approval = run.approvals.find((entry) => entry.id === approvalId);
  if (!approval) return;

  const api = await resolveDesktopApi();
  if (!api?.resolveApproval) {
    setStatus('Desktop bridge unavailable.');
    return;
  }

  const settings = getSettings();
  const prospectiveGrants =
    decision === 'approve' && approval.duration === 'workspace' && !workspaceGrantExists(activeWorkspace, approval)
      ? [
          ...activeWorkspace.permissionGrants,
          ...approval.targets.map((target) => ({
            id: uid('grant'),
            area: approval.area,
            target,
            duration: 'workspace' as const,
            grantedAt: Date.now(),
            note: approval.title
          }))
        ]
      : activeWorkspace.permissionGrants;

  setStatus(decision === 'approve' ? 'Recording approval...' : 'Blocking run...');

  try {
    const response: ResolveApprovalResponse = await api.resolveApproval({
      prompt: task.prompt,
      workspaceName: activeWorkspace.name,
      sessionTitle: session.title,
      recentTaskPrompts: taskContextPrompts(session, task.id),
      attachments: serializeAttachments(session),
      grants: prospectiveGrants,
      run,
      approvalId,
      decision,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort
    });

    task.runs = [response.run];
    task.updatedAt = Date.now();
    session.lastUpdated = Date.now();
    activeWorkspace.updatedAt = Date.now();
    if (decision === 'approve') {
      registerWorkspaceGrant(activeWorkspace, approval);
    }
    syncWorkspaceIndex(activeWorkspace);
    saveAll();
    applyContext();
    setStatus(response.run.status === 'completed' ? 'Run updated after approval.' : 'Approval saved.');
    setMetrics(`${response.run.latencyMs}ms approval update`);
  } catch (error) {
    setStatus(`Approval update failed: ${(error as Error).message}`);
  }
}

function openSettings(): void {
  const settings = getSettings();
  settingsModelInput.value = settings.model;
  settingsReasoningSelect.value = settings.reasoningEffort;
  shortcutSendInput.value = settings.shortcuts.sendMessage;
  shortcutNewSessionInput.value = settings.shortcuts.newSession;
  settingsModalEl.classList.remove('hidden');
}

function closeSettings(): void {
  settingsModalEl.classList.add('hidden');
}

function saveSettings(): void {
  if (!appState) return;

  const model = settingsModelInput.value.trim();
  const reasoning = settingsReasoningSelect.value;
  const sendShortcut = shortcutSendInput.value.trim();
  const newSessionShortcut = shortcutNewSessionInput.value.trim();

  if (!model) {
    setStatus('Model is required.');
    return;
  }

  if (!parseShortcut(sendShortcut) || !parseShortcut(newSessionShortcut)) {
    setStatus('Invalid shortcut format. Use e.g. Meta+Enter.');
    return;
  }

  if (reasoning !== 'low' && reasoning !== 'medium' && reasoning !== 'high' && reasoning !== 'xhigh') {
    setStatus('Invalid reasoning effort setting.');
    return;
  }

  appState.settings = {
    model,
    reasoningEffort: reasoning,
    shortcuts: {
      sendMessage: sendShortcut,
      newSession: newSessionShortcut
    }
  };

  updateRuntimeChips();
  void saveAppState();
  setStatus('Settings saved.');
  closeSettings();
  void refreshAuthStatus(false);
}

function attachEventHandlers(): void {
  attachFileButton.addEventListener('click', () => fileInput.click());
  addAttachmentButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    void attachFilesToCurrentSession(fileInput.files);
    fileInput.value = '';
  });
  sendButton.addEventListener('click', () => {
    void sendPrompt();
  });

  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = `${promptInput.scrollHeight}px`;
  });

  workspaceListEl.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;

    const action = target.getAttribute('data-action');
    const workspaceId = target.getAttribute('data-workspace-id') ?? '';
    if (action === 'switch-workspace') {
      void switchToWorkspace(workspaceId);
      return;
    }
    if (action === 'new-session') {
      if (!activeWorkspace || activeWorkspace.id !== workspaceId) {
        void switchToWorkspace(workspaceId).then(() => createSession(workspaceId));
      } else {
        createSession(workspaceId);
      }
      return;
    }
    if (action === 'delete-workspace') {
      void deleteWorkspace(workspaceId);
    }
  });

  sessionListEl.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;

    const action = target.getAttribute('data-action');
    const sessionId = target.getAttribute('data-session-id') ?? '';
    if (action === 'switch-session') {
      switchSession(sessionId);
      return;
    }
    if (action === 'delete-session') {
      void deleteSession(sessionId);
    }
  });

  attachmentChipsEl.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;

    const action = target.getAttribute('data-action');
    if (action !== 'remove-attachment') return;
    const attachmentId = target.getAttribute('data-attachment-id') ?? '';
    const storedFileName = target.getAttribute('data-stored-file') ?? '';
    void removeAttachment(attachmentId, storedFileName);
  });

  taskFeedEl.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;

    if (target.getAttribute('data-action') !== 'resolve-approval') return;
    const taskId = target.getAttribute('data-task-id') ?? '';
    const approvalId = target.getAttribute('data-approval-id') ?? '';
    const decision = (target.getAttribute('data-decision') ?? 'deny') as 'approve' | 'deny';
    void resolveApproval(taskId, approvalId, decision);
  });

  newWorkspaceButton.addEventListener('click', () => {
    void createWorkspace();
  });
  newSessionButton.addEventListener('click', () => {
    if (activeWorkspace) createSession(activeWorkspace.id);
  });
  openSettingsButton.addEventListener('click', () => openSettings());
  closeSettingsButton.addEventListener('click', () => closeSettings());
  saveSettingsButton.addEventListener('click', () => saveSettings());
  recheckAuthButton.addEventListener('click', () => {
    void refreshAuthStatus(true);
  });

  confirmCancelButton.addEventListener('click', () => closeConfirm(false));
  confirmOkButton.addEventListener('click', () => closeConfirm(true));
  confirmModalEl.addEventListener('click', (event) => {
    if (event.target === confirmModalEl) closeConfirm(false);
  });
  settingsModalEl.addEventListener('click', (event) => {
    if (event.target === settingsModalEl) closeSettings();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!confirmModalEl.classList.contains('hidden')) {
        closeConfirm(false);
        return;
      }
      if (!settingsModalEl.classList.contains('hidden')) {
        closeSettings();
      }
      return;
    }

    if (!settingsModalEl.classList.contains('hidden') || !confirmModalEl.classList.contains('hidden')) return;

    const settings = getSettings();
    if (shortcutMatches(event, settings.shortcuts.sendMessage)) {
      event.preventDefault();
      void sendPrompt();
      return;
    }

    if (shortcutMatches(event, settings.shortcuts.newSession)) {
      event.preventDefault();
      if (activeWorkspace) {
        createSession(activeWorkspace.id);
      }
    }
  });
}

async function boot(): Promise<void> {
  attachEventHandlers();
  setStatus('Initializing...');
  setMetrics('');

  const api = await resolveDesktopApi();
  let loadedState: AppState | null = null;

  if (api?.loadAppState) {
    loadedState = await api.loadAppState();
  }

  if (!loadedState) {
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw && api?.migrateLegacyState) {
      setStatus('Migrating data...');
      try {
        const result = await api.migrateLegacyState({ legacyState: legacyRaw });
        if (result.success) {
          loadedState = result.appState;
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        }
      } catch (error) {
        console.error('[cowork] migration failed:', error);
      }
    }
  }

  if (!loadedState) {
    activeWorkspace = createDefaultWorkspace();
    loadedState = {
      workspaceIndex: [{ id: activeWorkspace.id, name: activeWorkspace.name, updatedAt: activeWorkspace.updatedAt }],
      activeWorkspaceId: activeWorkspace.id,
      activeSessionId: activeWorkspace.sessions[0]?.id ?? null,
      settings: { ...DEFAULT_SETTINGS }
    };
    if (api?.saveWorkspace) {
      api.saveWorkspace({ workspace: activeWorkspace }).catch(() => undefined);
    }
  }

  appState = loadedState;

  if (appState.activeWorkspaceId && api?.loadWorkspace) {
    const { workspace } = await api.loadWorkspace({ workspaceId: appState.activeWorkspaceId });
    activeWorkspace = workspace;
  }

  if (!activeWorkspace && appState.workspaceIndex.length > 0 && api?.loadWorkspace) {
    const { workspace } = await api.loadWorkspace({ workspaceId: appState.workspaceIndex[0].id });
    activeWorkspace = workspace;
    appState.activeWorkspaceId = workspace?.id ?? null;
  }

  if (!activeWorkspace) {
    activeWorkspace = createDefaultWorkspace();
    syncWorkspaceIndex(activeWorkspace);
    appState.activeWorkspaceId = activeWorkspace.id;
    appState.activeSessionId = activeWorkspace.sessions[0]?.id ?? null;
    if (api?.saveWorkspace) {
      api.saveWorkspace({ workspace: activeWorkspace }).catch(() => undefined);
    }
  }

  const activeSessionId = appState.activeSessionId;
  if (!activeSessionId || !activeWorkspace.sessions.some((session) => session.id === activeSessionId)) {
    appState.activeSessionId = activeWorkspace.sessions[0]?.id ?? null;
  }

  void saveAppState();
  updateRuntimeChips();
  applyContext();
  setStatus('Checking GitHub authentication...');
  void refreshAuthStatus(false);
}

void boot();
