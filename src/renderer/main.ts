import Papa, { type ParseResult } from 'papaparse';
import './styles.css';
import type {
  AppSettings,
  AppState,
  ChatMessageData,
  ChatResponse,
  ConversationMessage,
  CopilotAuthStatusResponse,
  DocumentContext,
  GlobalThread,
  ProjectMetadata,
  ReasoningEffort,
  SessionMetadata,
  StoredDocument
} from '../shared/contracts.js';

type Cell = string | number | boolean | null;
type DataRow = Record<string, Cell>;
type ExcelCellValue = import('exceljs').CellValue;

interface Dataset {
  headers: string[];
  rows: DataRow[];
  numericColumns: string[];
}

interface ShortcutDefinition {
  key: string;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

interface AuthGateState {
  checking: boolean;
  status: CopilotAuthStatusResponse | null;
}

type DocumentPilotApi = Window['documentPilot'];

type SelectedInput =
  | { kind: 'tabular'; dataset: Dataset; fileName: string }
  | { kind: 'pdf'; file: File; fileName: string }
  | { kind: 'stored-tabular'; dataset: Dataset; fileName: string; docId: string }
  | { kind: 'stored-pdf'; fileData: ArrayBuffer; fileName: string; docId: string };

type ActiveContext =
  | { kind: 'project'; projectId: string; sessionId: string }
  | { kind: 'global-thread'; threadId: string };

// ── Constants ─────────────────────────────────────────────────────

const LEGACY_STORAGE_KEY = 'document-pilot.ui.v1';
const DEFAULT_SETTINGS: AppSettings = {
  model: 'gpt-5-mini',
  reasoningEffort: 'high',
  shortcuts: {
    sendMessage: 'Meta+Enter',
    newSession: 'Meta+Shift+N'
  }
};

const MAX_TEXT_CONTENT_ROWS = 200;

// ── DOM Elements ──────────────────────────────────────────────────

const fileInput = requireElement<HTMLInputElement>('#file-input');
const attachFileButton = requireElement<HTMLButtonElement>('#attach-file');
const promptInput = requireElement<HTMLTextAreaElement>('#prompt');
const sendButton = requireElement<HTMLButtonElement>('#send');
const statusEl = requireElement<HTMLSpanElement>('#status');
const metricsEl = requireElement<HTMLDivElement>('#metrics');
const fileChipEl = requireElement<HTMLSpanElement>('#file-chip');
const sessionTitleEl = requireElement<HTMLHeadingElement>('#session-title');
const sessionSubtitleEl = requireElement<HTMLParagraphElement>('#session-subtitle');
const runtimeIndicatorEl = requireElement<HTMLDivElement>('#runtime-indicator');
const modelChipEl = requireElement<HTMLSpanElement>('#model-chip');
const reasoningChipEl = requireElement<HTMLSpanElement>('#reasoning-chip');
const projectListEl = requireElement<HTMLDivElement>('#project-list');
const threadListEl = requireElement<HTMLDivElement>('#thread-list');
const newProjectButton = requireElement<HTMLButtonElement>('#new-project');
const newThreadButton = requireElement<HTMLButtonElement>('#new-thread');
const openSettingsButton = requireElement<HTMLButtonElement>('#open-settings');
const chatLogEl = requireElement<HTMLDivElement>('#chat-log');
const composerEl = requireElement<HTMLElement>('.composer');
const authGateEl = requireElement<HTMLElement>('#auth-gate');
const authMessageEl = requireElement<HTMLParagraphElement>('#auth-message');
const recheckAuthButton = requireElement<HTMLButtonElement>('#recheck-auth');

const documentBarEl = requireElement<HTMLDivElement>('#document-bar');
const documentChipsEl = requireElement<HTMLDivElement>('#document-chips');
const addDocumentButton = requireElement<HTMLButtonElement>('#add-document');

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

// ── State ─────────────────────────────────────────────────────────

let appState: AppState | null = null;
let activeProject: ProjectMetadata | null = null;
let activeContext: ActiveContext = { kind: 'project', projectId: '', sessionId: '' };
let lastParseMs = 0;
let authGateState: AuthGateState = { checking: true, status: null };
let desktopApiCache: Partial<DocumentPilotApi> | null = null;

const documentCache = new Map<string, SelectedInput>();
let pendingConfirm: { resolve: (ok: boolean) => void } | null = null;

// ── Utilities ─────────────────────────────────────────────────────

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
}

function toNumber(value: Cell): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const maybe = Number(value);
    if (Number.isFinite(maybe)) return maybe;
  }
  return undefined;
}

function inferNumericColumns(headers: string[], rows: DataRow[]): string[] {
  return headers.filter((header) => {
    let numeric = 0;
    let seen = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const value = rows[i]?.[header];
      if (value === null || value === undefined || value === '') continue;
      seen += 1;
      if (toNumber(value) !== undefined) numeric += 1;
    }
    return seen > 0 && numeric / seen >= 0.7;
  });
}

function normalizeParsedDataset(headers: string[], rows: DataRow[], sourceLabel: string): Dataset {
  const filteredHeaders = headers.filter((header) => Boolean(header));
  const filteredRows = rows.filter((row) => Object.values(row).some((v) => v !== null && v !== ''));
  if (filteredHeaders.length === 0 || filteredRows.length === 0) {
    throw new Error(`${sourceLabel} did not contain parseable rows with headers.`);
  }
  return {
    headers: filteredHeaders,
    rows: filteredRows,
    numericColumns: inferNumericColumns(filteredHeaders, filteredRows)
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ── Parsing ───────────────────────────────────────────────────────

function parseCsv(file: File): Promise<Dataset> {
  return new Promise((resolve, reject) => {
    Papa.parse<DataRow>(file, {
      header: true,
      worker: true,
      dynamicTyping: true,
      skipEmptyLines: 'greedy',
      complete: (results: ParseResult<DataRow>) => {
        if (results.errors.length > 0) {
          reject(new Error(results.errors[0].message));
          return;
        }
        const rows = (results.data ?? []).map((row) => row ?? {});
        const headers = results.meta.fields ?? [];
        resolve(normalizeParsedDataset(headers, rows, 'CSV'));
      },
      error: (error: Error) => reject(error)
    });
  });
}

async function parseExcel(file: File): Promise<Dataset> {
  const { default: ExcelJS } = await import('exceljs');
  const buffer = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets.find((sheet) => sheet.actualRowCount > 0);
  if (!worksheet) throw new Error('Excel workbook does not contain a non-empty sheet.');

  const normalizeExcelCell = (value: ExcelCellValue | undefined): Cell => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      if ('result' in value) return normalizeExcelCell(value.result as ExcelCellValue);
      if ('text' in value && typeof value.text === 'string') return value.text;
      if ('richText' in value && Array.isArray(value.richText)) {
        return value.richText.map((part: { text?: string }) => part.text ?? '').join('');
      }
      if ('error' in value && typeof value.error === 'string') return value.error;
    }
    return String(value);
  };

  const firstRow = worksheet.getRow(1);
  const headers: string[] = [];
  firstRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const raw = normalizeExcelCell(cell.value);
    const header = raw === null ? '' : String(raw).trim();
    if (header) headers[colNumber - 1] = header;
  });

  let dataStartRow = 2;
  if (headers.filter(Boolean).length === 0) {
    dataStartRow = 1;
    for (let col = 1; col <= worksheet.actualColumnCount; col += 1) {
      headers[col - 1] = `Column ${col}`;
    }
  }

  const rows: DataRow[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber < dataStartRow) return;
    const output: DataRow = {};
    for (let col = 1; col <= headers.length; col += 1) {
      const header = headers[col - 1];
      if (!header) continue;
      output[header] = normalizeExcelCell(row.getCell(col).value);
    }
    rows.push(output);
  });

  return normalizeParsedDataset(headers, rows, `Excel sheet "${worksheet.name}"`);
}

function isExcelFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  return lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || file.type.includes('spreadsheetml') || file.type.includes('excel');
}

function isPdfFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  return lower.endsWith('.pdf') || file.type === 'application/pdf';
}

async function parseDataset(file: File): Promise<Dataset> {
  return isExcelFile(file) ? parseExcel(file) : parseCsv(file);
}

function buildTabularTextContent(dataset: Dataset): string {
  const headers = dataset.headers;
  const rows = dataset.rows.slice(0, MAX_TEXT_CONTENT_ROWS);
  const headerLine = `| ${headers.join(' | ')} |`;
  const separatorLine = `| ${headers.map(() => '---').join(' | ')} |`;
  const dataLines = rows.map((row) => {
    const cells = headers.map((h) => {
      const val = row[h];
      return val === null || val === undefined ? '' : String(val);
    });
    return `| ${cells.join(' | ')} |`;
  });
  const lines = [headerLine, separatorLine, ...dataLines];
  if (dataset.rows.length > MAX_TEXT_CONTENT_ROWS) {
    lines.push(`\n(Showing first ${MAX_TEXT_CONTENT_ROWS} of ${dataset.rows.length} rows)`);
  }
  return lines.join('\n');
}

// ── Desktop API ───────────────────────────────────────────────────

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

// ── Confirm Dialog ────────────────────────────────────────────────

function showConfirm(message: string): Promise<boolean> {
  confirmMessageEl.textContent = message;
  confirmModalEl.classList.remove('hidden');
  return new Promise((resolve) => {
    pendingConfirm = { resolve };
  });
}

function closeConfirm(result: boolean): void {
  confirmModalEl.classList.add('hidden');
  if (pendingConfirm) {
    pendingConfirm.resolve(result);
    pendingConfirm = null;
  }
}

// ── Status Helpers ────────────────────────────────────────────────

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function setMetrics(message: string): void {
  metricsEl.textContent = message;
}

// ── Auth Gate ─────────────────────────────────────────────────────

function getAuthBlockReason(status: CopilotAuthStatusResponse | null): string | null {
  if (!status) return 'Checking GitHub authentication...';
  if (!status.ok) return `Copilot SDK unavailable: ${status.statusMessage}`;
  if (!status.isAuthenticated) return status.statusMessage;
  if (status.modelAvailable === false) return `Model "${status.model}" is not available for this account.`;
  return null;
}

function getSettings(): AppSettings {
  return appState?.settings ?? DEFAULT_SETTINGS;
}

function applyAuthGate(): void {
  const reason = authGateState.checking ? 'Checking GitHub authentication...' : getAuthBlockReason(authGateState.status);
  const locked = authGateState.checking || Boolean(reason);
  composerEl.classList.toggle('locked', locked);
  attachFileButton.disabled = locked;
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
        ok: false, isAuthenticated: false,
        statusMessage: 'Desktop bridge unavailable. Restart the app to reload the preload script.',
        model: settings.model, checkedAt: Date.now()
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
        ok: true, isAuthenticated: true,
        statusMessage: 'Auth precheck unavailable in this runtime. Continuing and validating on send.',
        model: settings.model, checkedAt: Date.now()
      }
    };
    applyAuthGate();
    if (announceSuccess) setStatus('Bridge compatibility mode: auth will be validated when sending a request.');
    return true;
  }

  try {
    const status = await api.getCopilotAuthStatus({ model: settings.model });
    authGateState = { checking: false, status };
  } catch (error) {
    authGateState = {
      checking: false,
      status: {
        ok: false, isAuthenticated: false,
        statusMessage: (error as Error).message || 'Unable to check Copilot authentication.',
        model: settings.model, checkedAt: Date.now()
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

// ── Shortcuts ─────────────────────────────────────────────────────

function parseShortcut(value: string): ShortcutDefinition | null {
  const parts = value.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
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
  const eventKey = event.key.toLowerCase();
  const normalizedKey = eventKey === 'return' ? 'enter' : eventKey;
  return normalizedKey === shortcut.key && event.metaKey === shortcut.meta && event.shiftKey === shortcut.shift && event.altKey === shortcut.alt && event.ctrlKey === shortcut.ctrl;
}

// ── State Persistence ─────────────────────────────────────────────

async function saveAppState(): Promise<void> {
  if (!appState) return;
  const api = await resolveDesktopApi();
  if (api?.saveAppState) {
    api.saveAppState({ state: appState }).catch((err) =>
      console.error('[document-pilot] saveAppState failed:', err)
    );
  }
}

async function saveActiveProject(): Promise<void> {
  if (!activeProject) return;
  const api = await resolveDesktopApi();
  if (api?.saveProject) {
    api.saveProject({ project: activeProject }).catch((err) =>
      console.error('[document-pilot] saveProject failed:', err)
    );
  }
}

function saveAll(): void {
  void saveAppState();
  if (activeContext.kind === 'project' && activeProject) {
    void saveActiveProject();
  }
}

// ── Getters ───────────────────────────────────────────────────────

function getActiveThread(): GlobalThread | null {
  if (activeContext.kind !== 'global-thread' || !appState) return null;
  const threadId = activeContext.threadId;
  return appState.globalThreads.find((t) => t.id === threadId) ?? null;
}

function getActiveSession(): SessionMetadata | null {
  if (activeContext.kind !== 'project' || !activeProject) return null;
  const sessionId = activeContext.sessionId;
  return activeProject.sessions.find((s) => s.id === sessionId) ?? null;
}

function getActiveMessages(): ChatMessageData[] {
  if (activeContext.kind === 'global-thread') {
    return getActiveThread()?.messages ?? [];
  }
  return getActiveSession()?.messages ?? [];
}

function getActiveDocuments(): StoredDocument[] {
  if (activeContext.kind === 'global-thread') {
    return getActiveThread()?.documents ?? [];
  }
  return activeProject?.documents ?? [];
}

function getActiveDocumentId(): string | null {
  if (activeContext.kind === 'global-thread') {
    return getActiveThread()?.activeDocumentId ?? null;
  }
  return getActiveSession()?.activeDocumentId ?? null;
}

function setActiveDocumentId(docId: string | null): void {
  if (activeContext.kind === 'global-thread') {
    const thread = getActiveThread();
    if (thread) thread.activeDocumentId = docId;
  } else {
    const session = getActiveSession();
    if (session) session.activeDocumentId = docId;
  }
}

// ── Rendering ─────────────────────────────────────────────────────

function messageHtml(message: ChatMessageData): string {
  const cls = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system';
  const meta = message.meta ? `<div class="msg-meta">${escapeHtml(message.meta)}</div>` : '';
  return `<article class="msg ${cls}">${escapeHtml(message.content)}${meta}</article>`;
}

function updateRuntimeChips(): void {
  const settings = getSettings();
  modelChipEl.textContent = `Model: ${settings.model}`;
  reasoningChipEl.textContent = `Reasoning: ${settings.reasoningEffort}`;
  runtimeIndicatorEl.textContent = `Model: ${settings.model} | Reasoning: ${settings.reasoningEffort}`;
}

function renderDocumentBar(): void {
  const docs = getActiveDocuments();
  const activeDocId = getActiveDocumentId();

  if (docs.length === 0) {
    documentBarEl.classList.add('hidden');
    return;
  }

  documentBarEl.classList.remove('hidden');
  documentChipsEl.innerHTML = docs
    .map((doc) => {
      const activeClass = doc.id === activeDocId ? 'active' : '';
      return [
        `<span class="doc-chip ${activeClass}" data-action="select-doc" data-doc-id="${doc.id}">`,
        escapeHtml(doc.originalFileName),
        `<span class="doc-chip-remove" data-action="remove-doc" data-doc-id="${doc.id}" data-stored="${escapeHtml(doc.storedFileName)}">&times;</span>`,
        '</span>'
      ].join('');
    })
    .join('');
}

function renderProjectList(): void {
  if (!appState) return;
  const currentSessionId = activeContext.kind === 'project' ? activeContext.sessionId : '';

  projectListEl.innerHTML = appState.projectIndex
    .map((entry) => {
      const isActiveProject = activeContext.kind === 'project' && activeContext.projectId === entry.id;
      const docCount = isActiveProject && activeProject ? activeProject.documents.length : 0;
      const badge = docCount > 0 ? `<span class="doc-badge">${docCount}</span>` : '';

      let sessionsHtml = '';
      if (isActiveProject && activeProject) {
        sessionsHtml = activeProject.sessions
          .map((session) => {
            const activeClass = session.id === currentSessionId ? 'active' : '';
            return [
              `<div class="session-row">`,
              `<button class="session-btn ${activeClass}" data-action="switch-session" data-project-id="${entry.id}" data-session-id="${session.id}">`,
              `<span>${escapeHtml(session.title)}</span>`,
              `<span class="session-time">${formatRelativeTime(session.lastUpdated)}</span>`,
              '</button>',
              `<button class="delete-btn" data-action="delete-session" data-project-id="${entry.id}" data-session-id="${session.id}" type="button">&times;</button>`,
              '</div>'
            ].join('');
          })
          .join('');
      }

      return [
        `<div class="project-card" data-project-id="${entry.id}">`,
        '<div class="project-head">',
        `<button class="project-title-btn" data-action="switch-project" data-project-id="${entry.id}">${escapeHtml(entry.name)}${badge}</button>`,
        '<div class="project-tools">',
        `<button class="ghost ghost-sm" data-action="new-session" data-project-id="${entry.id}" type="button">+ Session</button>`,
        `<button class="delete-btn" data-action="delete-project" data-project-id="${entry.id}" type="button">&times;</button>`,
        '</div>',
        '</div>',
        isActiveProject ? `<div class="session-list">${sessionsHtml}</div>` : '',
        '</div>'
      ].join('');
    })
    .join('');
}

function renderThreadList(): void {
  if (!appState) return;

  threadListEl.innerHTML = appState.globalThreads
    .map((thread) => {
      const isActive = activeContext.kind === 'global-thread' && activeContext.threadId === thread.id;
      const activeClass = isActive ? 'active' : '';
      const docBadge = thread.documents.length > 0 ? `<span class="doc-badge">${thread.documents.length}</span>` : '';

      return [
        `<button class="thread-btn ${activeClass}" data-action="switch-thread" data-thread-id="${thread.id}">`,
        `<span>${escapeHtml(thread.title)}</span>`,
        '<span class="thread-tools">',
        docBadge,
        `<span class="session-time">${formatRelativeTime(thread.lastUpdated)}</span>`,
        `<span class="delete-btn" data-action="delete-thread" data-thread-id="${thread.id}">&times;</span>`,
        '</span>',
        '</button>'
      ].join('');
    })
    .join('');
}

function updateActiveInput(): void {
  const activeDocId = getActiveDocumentId();
  if (activeDocId && documentCache.has(activeDocId)) {
    const cached = documentCache.get(activeDocId)!;
    fileChipEl.textContent = cached.fileName;
  } else if (activeDocId) {
    fileChipEl.textContent = 'Loading document...';
    void loadAndCacheDocument(activeDocId);
  } else {
    fileChipEl.textContent = 'No file attached';
  }
}

function applySessionContext(): void {
  const messages = getActiveMessages();

  if (activeContext.kind === 'project' && activeProject) {
    const session = getActiveSession();
    sessionTitleEl.textContent = session?.title ?? 'Session';
    sessionSubtitleEl.textContent = `${activeProject.name} • ${messages.length} messages`;
  } else if (activeContext.kind === 'global-thread') {
    const thread = getActiveThread();
    sessionTitleEl.textContent = thread?.title ?? 'Thread';
    sessionSubtitleEl.textContent = `Global Thread • ${messages.length} messages`;
  }

  chatLogEl.innerHTML = '';
  if (messages.length === 0) {
    chatLogEl.innerHTML = '<article class="msg assistant">Attach a CSV, Excel, or PDF file and ask your first question.</article>';
  } else {
    chatLogEl.innerHTML = messages.map((item) => messageHtml(item)).join('');
  }
  chatLogEl.scrollTop = chatLogEl.scrollHeight;

  updateActiveInput();
  renderDocumentBar();
  renderProjectList();
  renderThreadList();
}

// ── Document Loading ──────────────────────────────────────────────

async function loadAndCacheDocument(docId: string): Promise<void> {
  const docs = getActiveDocuments();
  const doc = docs.find((d) => d.id === docId);
  if (!doc) return;

  const targetId = activeContext.kind === 'project' ? activeContext.projectId : activeContext.threadId;
  const api = await resolveDesktopApi();
  if (!api?.readDocument) return;

  try {
    const result = await api.readDocument({ targetId, storedFileName: doc.storedFileName });

    if (doc.kind === 'pdf') {
      documentCache.set(docId, {
        kind: 'stored-pdf',
        fileData: result.fileData,
        fileName: doc.originalFileName,
        docId
      });
    } else {
      const blob = new Blob([result.fileData]);
      const file = new File([blob], doc.originalFileName);
      const dataset = await parseDataset(file);
      documentCache.set(docId, {
        kind: 'stored-tabular',
        dataset,
        fileName: doc.originalFileName,
        docId
      });
    }

    updateActiveInput();
  } catch (error) {
    console.error('[document-pilot] failed to load document:', error);
    setStatus(`Failed to load document: ${(error as Error).message}`);
  }
}

// ── Document Attachment ───────────────────────────────────────────

async function attachDocumentToCurrentContext(file: File): Promise<void> {
  const api = await resolveDesktopApi();
  if (!api?.copyDocument) {
    setStatus('Desktop bridge unavailable.');
    return;
  }

  const targetId = activeContext.kind === 'project' ? activeContext.projectId : activeContext.threadId;
  const documentId = uid('doc');
  const fileData = await file.arrayBuffer();

  setStatus(`Saving ${file.name}...`);

  try {
    const { storedDocument } = await api.copyDocument({
      targetId,
      documentId,
      originalFileName: file.name,
      fileData
    });

    // Add to the in-memory model
    if (activeContext.kind === 'project' && activeProject) {
      activeProject.documents.push(storedDocument);
      activeProject.updatedAt = Date.now();
    } else if (activeContext.kind === 'global-thread') {
      const thread = getActiveThread();
      if (thread) {
        thread.documents.push(storedDocument);
        thread.lastUpdated = Date.now();
      }
    }

    // Parse and cache locally
    const startedAt = performance.now();
    if (isPdfFile(file)) {
      documentCache.set(documentId, { kind: 'stored-pdf', fileData, fileName: file.name, docId: documentId });
      lastParseMs = Number((performance.now() - startedAt).toFixed(2));
    } else {
      const dataset = await parseDataset(file);
      documentCache.set(documentId, { kind: 'stored-tabular', dataset, fileName: file.name, docId: documentId });
      lastParseMs = Number((performance.now() - startedAt).toFixed(2));
    }

    // Set as active document
    setActiveDocumentId(documentId);

    saveAll();
    applySessionContext();
    setStatus(`Attached ${file.name}.`);
  } catch (error) {
    setStatus(`Failed to attach: ${(error as Error).message}`);
  }
}

async function removeDocument(docId: string, storedFileName: string): Promise<void> {
  const api = await resolveDesktopApi();
  if (!api?.deleteDocument) return;

  const targetId = activeContext.kind === 'project' ? activeContext.projectId : activeContext.threadId;

  try {
    await api.deleteDocument({ targetId, documentId: docId, storedFileName });
  } catch {
    // File may already be gone
  }

  if (activeContext.kind === 'project' && activeProject) {
    activeProject.documents = activeProject.documents.filter((d) => d.id !== docId);
    activeProject.updatedAt = Date.now();
  } else if (activeContext.kind === 'global-thread') {
    const thread = getActiveThread();
    if (thread) {
      thread.documents = thread.documents.filter((d) => d.id !== docId);
      thread.lastUpdated = Date.now();
    }
  }

  documentCache.delete(docId);

  // Clear active document if it was removed
  if (getActiveDocumentId() === docId) {
    const remaining = getActiveDocuments();
    setActiveDocumentId(remaining.length > 0 ? remaining[0].id : null);
  }

  saveAll();
  applySessionContext();
}

// ── Project CRUD ──────────────────────────────────────────────────

async function createProject(): Promise<void> {
  if (!appState) return;

  const name = window.prompt('Project name', 'New Project')?.trim();
  if (!name) return;

  const projectId = uid('project');
  const sessionId = uid('session');
  const now = Date.now();

  const project: ProjectMetadata = {
    id: projectId,
    name,
    documents: [],
    sessions: [{
      id: sessionId,
      title: 'New Session',
      messages: [],
      activeDocumentId: null,
      lastUpdated: now
    }],
    createdAt: now,
    updatedAt: now
  };

  appState.projectIndex.unshift({ id: projectId, name, updatedAt: now });
  appState.activeProjectId = projectId;
  appState.activeSessionId = sessionId;
  activeProject = project;
  activeContext = { kind: 'project', projectId, sessionId };

  saveAll();
  applySessionContext();

  // Prompt for first document
  fileInput.click();
}

async function deleteProject(projectId: string): Promise<void> {
  if (!appState) return;

  const entry = appState.projectIndex.find((p) => p.id === projectId);
  if (!entry) return;

  const confirmed = await showConfirm(`Delete project "${entry.name}" and all its documents?`);
  if (!confirmed) return;

  const api = await resolveDesktopApi();
  if (api?.deleteProject) {
    await api.deleteProject({ projectId }).catch(() => {});
  }

  appState.projectIndex = appState.projectIndex.filter((p) => p.id !== projectId);

  // Clear active project if it was the deleted one
  if (activeContext.kind === 'project' && activeContext.projectId === projectId) {
    if (appState.projectIndex.length > 0) {
      void switchToProject(appState.projectIndex[0].id);
    } else if (appState.globalThreads.length > 0) {
      switchToThread(appState.globalThreads[0].id);
    } else {
      // Create a fresh project
      await createProject();
    }
  }

  void saveAppState();
  renderProjectList();
}

async function switchToProject(projectId: string): Promise<void> {
  if (!appState) return;

  const api = await resolveDesktopApi();
  if (!api?.loadProject) return;

  setStatus('Loading project...');
  const { project } = await api.loadProject({ projectId });

  if (!project) {
    setStatus('Project not found on disk.');
    return;
  }

  activeProject = project;
  const sessionId = project.sessions[0]?.id ?? '';
  activeContext = { kind: 'project', projectId, sessionId };
  appState.activeProjectId = projectId;
  appState.activeSessionId = sessionId;

  void saveAppState();
  applySessionContext();
  setStatus('');

  // Pre-load active document if set
  const activeDocId = getActiveDocumentId();
  if (activeDocId && !documentCache.has(activeDocId)) {
    void loadAndCacheDocument(activeDocId);
  }
}

function switchSession(projectId: string, sessionId: string): void {
  if (!appState || !activeProject) return;
  if (activeContext.kind !== 'project' || activeContext.projectId !== projectId) return;

  const session = activeProject.sessions.find((s) => s.id === sessionId);
  if (!session) return;

  activeContext = { kind: 'project', projectId, sessionId };
  appState.activeSessionId = sessionId;

  void saveAppState();
  applySessionContext();

  // Load session's active document if needed
  const docId = session.activeDocumentId;
  if (docId && !documentCache.has(docId)) {
    void loadAndCacheDocument(docId);
  }
}

function createSession(projectId: string): void {
  if (!appState || !activeProject || activeProject.id !== projectId) return;

  const sessionId = uid('session');
  const session: SessionMetadata = {
    id: sessionId,
    title: 'New Session',
    messages: [],
    activeDocumentId: null,
    lastUpdated: Date.now()
  };

  activeProject.sessions.unshift(session);
  activeProject.updatedAt = Date.now();
  activeContext = { kind: 'project', projectId, sessionId };
  appState.activeSessionId = sessionId;

  setStatus('New session created.');
  saveAll();
  applySessionContext();
}

async function deleteSession(projectId: string, sessionId: string): Promise<void> {
  if (!appState || !activeProject || activeProject.id !== projectId) return;

  const session = activeProject.sessions.find((s) => s.id === sessionId);
  if (!session) return;

  // Don't allow deleting the last session
  if (activeProject.sessions.length <= 1) {
    setStatus('Cannot delete the only session in a project.');
    return;
  }

  const confirmed = await showConfirm(`Delete session "${session.title}"?`);
  if (!confirmed) return;

  activeProject.sessions = activeProject.sessions.filter((s) => s.id !== sessionId);
  activeProject.updatedAt = Date.now();

  // If we deleted the active session, switch to the first remaining one
  if (activeContext.kind === 'project' && activeContext.sessionId === sessionId) {
    const nextSession = activeProject.sessions[0];
    activeContext = { kind: 'project', projectId, sessionId: nextSession.id };
    appState.activeSessionId = nextSession.id;
  }

  saveAll();
  applySessionContext();
}

// ── Global Thread CRUD ────────────────────────────────────────────

function createGlobalThread(): void {
  if (!appState) return;

  const threadId = uid('thread');
  const now = Date.now();

  const thread: GlobalThread = {
    id: threadId,
    title: 'New Thread',
    messages: [],
    documents: [],
    activeDocumentId: null,
    lastUpdated: now
  };

  appState.globalThreads.unshift(thread);
  appState.activeProjectId = null;
  appState.activeSessionId = threadId;
  activeProject = null;
  activeContext = { kind: 'global-thread', threadId };

  void saveAppState();
  applySessionContext();
}

function switchToThread(threadId: string): void {
  if (!appState) return;

  const thread = appState.globalThreads.find((t) => t.id === threadId);
  if (!thread) return;

  activeProject = null;
  activeContext = { kind: 'global-thread', threadId };
  appState.activeProjectId = null;
  appState.activeSessionId = threadId;

  void saveAppState();
  applySessionContext();

  // Load active document if needed
  const docId = thread.activeDocumentId;
  if (docId && !documentCache.has(docId)) {
    void loadAndCacheDocument(docId);
  }
}

async function deleteThread(threadId: string): Promise<void> {
  if (!appState) return;

  const thread = appState.globalThreads.find((t) => t.id === threadId);
  if (!thread) return;

  const confirmed = await showConfirm(`Delete thread "${thread.title}"?`);
  if (!confirmed) return;

  // Delete documents from disk
  const api = await resolveDesktopApi();
  for (const doc of thread.documents) {
    if (api?.deleteDocument) {
      await api.deleteDocument({ targetId: threadId, documentId: doc.id, storedFileName: doc.storedFileName }).catch(() => {});
    }
  }

  appState.globalThreads = appState.globalThreads.filter((t) => t.id !== threadId);

  if (activeContext.kind === 'global-thread' && activeContext.threadId === threadId) {
    if (appState.globalThreads.length > 0) {
      switchToThread(appState.globalThreads[0].id);
    } else if (appState.projectIndex.length > 0) {
      void switchToProject(appState.projectIndex[0].id);
    } else {
      await createProject();
    }
  }

  void saveAppState();
  renderThreadList();
}

// ── Add Message ───────────────────────────────────────────────────

function addMessage(role: ChatMessageData['role'], content: string, meta?: string): void {
  const msg: ChatMessageData = {
    id: uid('msg'),
    role,
    content,
    createdAt: Date.now(),
    meta
  };

  if (activeContext.kind === 'global-thread') {
    const thread = getActiveThread();
    if (!thread) return;
    thread.messages.push(msg);
    thread.lastUpdated = Date.now();
    if (thread.title === 'New Thread' && role === 'user') {
      thread.title = content.slice(0, 42).trim() || 'New Thread';
    }
  } else {
    const session = getActiveSession();
    if (!session) return;
    session.messages.push(msg);
    session.lastUpdated = Date.now();
    if (session.title === 'New Session' && role === 'user') {
      session.title = content.slice(0, 42).trim() || 'New Session';
    }
    if (activeProject) activeProject.updatedAt = Date.now();
  }

  saveAll();
  applySessionContext();
}

// ── File Attach Handler ───────────────────────────────────────────

async function handleFileAttach(): Promise<void> {
  if (!(await ensureAuthReady())) {
    fileInput.value = '';
    return;
  }

  const file = fileInput.files?.[0];
  if (!file) return;

  sendButton.disabled = true;
  setStatus(`Loading ${file.name}...`);

  try {
    await attachDocumentToCurrentContext(file);
  } catch (error) {
    setStatus(`Attach failed: ${(error as Error).message}`);
  } finally {
    sendButton.disabled = false;
    fileInput.value = '';
  }
}

// ── Send Prompt ───────────────────────────────────────────────────

function collectHistory(): ConversationMessage[] {
  return getActiveMessages()
    .filter((msg): msg is ChatMessageData & { role: 'user' | 'assistant' } => msg.role === 'user' || msg.role === 'assistant')
    .map((msg) => ({ role: msg.role, content: msg.content }));
}

function getSelectedInput(): SelectedInput | undefined {
  const docId = getActiveDocumentId();
  if (docId) return documentCache.get(docId);
  return undefined;
}

async function sendPrompt(): Promise<void> {
  if (!(await ensureAuthReady())) return;

  const prompt = promptInput.value.trim();
  if (!prompt) {
    setStatus('Enter a prompt first.');
    return;
  }

  const selectedInput = getSelectedInput();
  if (!selectedInput) {
    setStatus('Attach a CSV, Excel, or PDF file first.');
    return;
  }

  const api = await resolveDesktopApi();
  if (!api || typeof api.chat !== 'function') {
    setStatus('Desktop bridge unavailable. Restart the app and try again.');
    return;
  }

  const settings = getSettings();
  sendButton.disabled = true;
  promptInput.disabled = true;

  const startedAt = performance.now();
  const assistantMetaBase = `${settings.model} • ${settings.reasoningEffort}`;
  const history = collectHistory();
  addMessage('user', prompt, selectedInput.fileName);
  promptInput.value = '';

  try {
    setStatus('Thinking...');

    let document: DocumentContext;

    if (selectedInput.kind === 'tabular' || selectedInput.kind === 'stored-tabular') {
      document = {
        kind: 'tabular',
        fileName: selectedInput.fileName,
        textContent: buildTabularTextContent(selectedInput.dataset),
        rowCount: selectedInput.dataset.rows.length
      };
    } else if (selectedInput.kind === 'stored-pdf') {
      document = {
        kind: 'pdf',
        fileName: selectedInput.fileName,
        textContent: '',
        pdfData: selectedInput.fileData
      };
    } else {
      const pdfData = await selectedInput.file.arrayBuffer();
      document = {
        kind: 'pdf',
        fileName: selectedInput.fileName,
        textContent: '',
        pdfData
      };
    }

    const response: ChatResponse = await api.chat({
      prompt,
      document,
      history,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort
    });

    addMessage('assistant', response.answer, `${assistantMetaBase} • ${response.source}`);

    const totalMs = Number((performance.now() - startedAt).toFixed(2));
    setMetrics(`File: ${selectedInput.fileName} | Parse: ${lastParseMs}ms | AI: ${response.latencyMs}ms | Total: ${totalMs}ms`);
    setStatus(response.warning ? `Done (${response.warning})` : 'Done.');
    saveAll();
  } catch (error) {
    addMessage('assistant', `Request failed: ${(error as Error).message}`, assistantMetaBase);
    setStatus(`Request failed: ${(error as Error).message}`);
  } finally {
    sendButton.disabled = false;
    promptInput.disabled = false;
    promptInput.focus();
  }
}

// ── Settings ──────────────────────────────────────────────────────

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

  if (!model) { setStatus('Model is required.'); return; }
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
    shortcuts: { sendMessage: sendShortcut, newSession: newSessionShortcut }
  };

  updateRuntimeChips();
  void saveAppState();
  setStatus('Settings saved.');
  closeSettings();
  void refreshAuthStatus(false);
}

// ── Event Handlers ────────────────────────────────────────────────

function attachEventHandlers(): void {
  attachFileButton.addEventListener('click', () => fileInput.click());
  addDocumentButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { void handleFileAttach(); });
  sendButton.addEventListener('click', () => { void sendPrompt(); });

  // Project list delegation
  projectListEl.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;

    const action = target.getAttribute('data-action');
    const projectId = target.getAttribute('data-project-id') ?? '';
    const sessionId = target.getAttribute('data-session-id') ?? '';

    if (action === 'switch-project') { void switchToProject(projectId); return; }
    if (action === 'new-session') { createSession(projectId); return; }
    if (action === 'switch-session') { switchSession(projectId, sessionId); return; }
    if (action === 'delete-session') { void deleteSession(projectId, sessionId); return; }
    if (action === 'delete-project') { void deleteProject(projectId); return; }
  });

  // Thread list delegation
  threadListEl.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;

    const action = target.getAttribute('data-action');
    const threadId = target.getAttribute('data-thread-id') ?? '';

    if (action === 'switch-thread') { switchToThread(threadId); return; }
    if (action === 'delete-thread') { void deleteThread(threadId); return; }
  });

  // Document chips delegation
  documentChipsEl.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;

    const action = target.getAttribute('data-action');
    const docId = target.getAttribute('data-doc-id') ?? '';

    if (action === 'select-doc') {
      setActiveDocumentId(docId);
      saveAll();
      applySessionContext();
      if (!documentCache.has(docId)) void loadAndCacheDocument(docId);
      return;
    }

    if (action === 'remove-doc') {
      const storedName = target.getAttribute('data-stored') ?? '';
      void removeDocument(docId, storedName);
    }
  });

  newProjectButton.addEventListener('click', () => { void createProject(); });
  newThreadButton.addEventListener('click', () => createGlobalThread());
  openSettingsButton.addEventListener('click', () => openSettings());
  closeSettingsButton.addEventListener('click', () => closeSettings());
  saveSettingsButton.addEventListener('click', () => saveSettings());
  recheckAuthButton.addEventListener('click', () => { void refreshAuthStatus(true); });

  // Confirm dialog
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
      if (!confirmModalEl.classList.contains('hidden')) { closeConfirm(false); return; }
      if (!settingsModalEl.classList.contains('hidden')) { closeSettings(); return; }
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
      if (activeContext.kind === 'project') {
        createSession(activeContext.projectId);
      } else {
        createGlobalThread();
      }
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  attachEventHandlers();
  setStatus('Initializing...');
  setMetrics('');

  const api = await resolveDesktopApi();

  // Step 1: Try to load persisted app state
  let loadedState: AppState | null = null;
  if (api?.loadAppState) {
    loadedState = await api.loadAppState();
  }

  // Step 2: Check for legacy localStorage data
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
        console.error('[document-pilot] migration failed:', error);
      }
    }
  }

  // Step 3: Create fresh state if nothing was loaded
  if (!loadedState) {
    const projectId = uid('project');
    const sessionId = uid('session');
    const now = Date.now();

    loadedState = {
      projectIndex: [{ id: projectId, name: 'Document Pilot', updatedAt: now }],
      globalThreads: [],
      activeProjectId: projectId,
      activeSessionId: sessionId,
      settings: { ...DEFAULT_SETTINGS }
    };

    // Also create the project file on disk
    const freshProject: ProjectMetadata = {
      id: projectId,
      name: 'Document Pilot',
      documents: [],
      sessions: [{
        id: sessionId,
        title: 'New Session',
        messages: [],
        activeDocumentId: null,
        lastUpdated: now
      }],
      createdAt: now,
      updatedAt: now
    };

    activeProject = freshProject;
    if (api?.saveProject) api.saveProject({ project: freshProject }).catch(() => {});
  }

  appState = loadedState;

  // Step 4: Restore active context
  if (appState.activeProjectId) {
    const projectId = appState.activeProjectId;
    if (api?.loadProject) {
      const { project } = await api.loadProject({ projectId });
      activeProject = project;
    }

    if (activeProject) {
      const sessionId = appState.activeSessionId && activeProject.sessions.some((s) => s.id === appState!.activeSessionId)
        ? appState.activeSessionId
        : activeProject.sessions[0]?.id ?? '';
      activeContext = { kind: 'project', projectId, sessionId };
      appState.activeSessionId = sessionId;
    } else {
      // Project file is missing, fall back
      if (appState.globalThreads.length > 0) {
        activeContext = { kind: 'global-thread', threadId: appState.globalThreads[0].id };
      } else {
        // Create a fresh project
        const projectId2 = uid('project');
        const sessionId2 = uid('session');
        const now = Date.now();
        appState.projectIndex = [{ id: projectId2, name: 'Document Pilot', updatedAt: now }];
        appState.activeProjectId = projectId2;
        appState.activeSessionId = sessionId2;
        activeProject = {
          id: projectId2, name: 'Document Pilot', documents: [],
          sessions: [{ id: sessionId2, title: 'New Session', messages: [], activeDocumentId: null, lastUpdated: now }],
          createdAt: now, updatedAt: now
        };
        activeContext = { kind: 'project', projectId: projectId2, sessionId: sessionId2 };
        if (api?.saveProject) api.saveProject({ project: activeProject }).catch(() => {});
      }
    }
  } else if (appState.globalThreads.length > 0) {
    const threadId = appState.activeSessionId && appState.globalThreads.some((t) => t.id === appState!.activeSessionId)
      ? appState.activeSessionId
      : appState.globalThreads[0].id;
    activeContext = { kind: 'global-thread', threadId };
  } else if (appState.projectIndex.length > 0) {
    void switchToProject(appState.projectIndex[0].id);
  }

  void saveAppState();
  updateRuntimeChips();
  applySessionContext();
  setStatus('Checking GitHub authentication...');
  void refreshAuthStatus(false);

  // Pre-load active document
  const activeDocId = getActiveDocumentId();
  if (activeDocId && !documentCache.has(activeDocId)) {
    void loadAndCacheDocument(activeDocId);
  }
}

boot();
