import { Chart, registerables, type ChartConfiguration } from 'chart.js';
import Papa, { type ParseResult } from 'papaparse';
import './styles.css';
import type {
  AnalyzeDatasetResponse,
  AnalyzePdfResponse,
  CopilotAuthStatusResponse,
  DatasetSummary,
  ReasoningEffort,
  VisualizationPlan
} from '../shared/contracts.js';

Chart.register(...registerables);

type Cell = string | number | boolean | null;
type DataRow = Record<string, Cell>;
type ExcelCellValue = import('exceljs').CellValue;

interface Dataset {
  headers: string[];
  rows: DataRow[];
  numericColumns: string[];
}

interface Point {
  label: string;
  value: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  meta?: string;
}

interface ChartSnapshot {
  plan: VisualizationPlan;
  points: Point[];
}

interface SessionState {
  id: string;
  title: string;
  messages: ChatMessage[];
  lastUpdated: number;
  chart?: ChartSnapshot;
}

interface ProjectState {
  id: string;
  name: string;
  sessions: SessionState[];
  createdAt: number;
}

interface KeyboardShortcuts {
  sendMessage: string;
  newSession: string;
}

interface AppSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
  shortcuts: KeyboardShortcuts;
}

interface PersistedState {
  projects: ProjectState[];
  activeProjectId: string;
  activeSessionId: string;
  settings: AppSettings;
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
  | { kind: 'pdf'; file: File; fileName: string };

const STORAGE_KEY = 'document-pilot.ui.v1';
const GOALS_FOR_ALIASES = ['goals_for', 'goals for', 'gf', 'goals scored', 'for'];
const GOALS_AGAINST_ALIASES = ['goals_against', 'goals against', 'ga', 'goals conceded', 'against'];

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
const newProjectButton = requireElement<HTMLButtonElement>('#new-project');
const openSettingsButton = requireElement<HTMLButtonElement>('#open-settings');
const chatLogEl = requireElement<HTMLDivElement>('#chat-log');
const chartPanelEl = requireElement<HTMLElement>('#chart-panel');
const chartCanvas = requireElement<HTMLCanvasElement>('#chart');
const composerEl = requireElement<HTMLElement>('.composer');
const authGateEl = requireElement<HTMLElement>('#auth-gate');
const authMessageEl = requireElement<HTMLParagraphElement>('#auth-message');
const recheckAuthButton = requireElement<HTMLButtonElement>('#recheck-auth');

const settingsModalEl = requireElement<HTMLDivElement>('#settings-modal');
const closeSettingsButton = requireElement<HTMLButtonElement>('#close-settings');
const saveSettingsButton = requireElement<HTMLButtonElement>('#save-settings');
const settingsModelInput = requireElement<HTMLInputElement>('#settings-model');
const settingsReasoningSelect = requireElement<HTMLSelectElement>('#settings-reasoning');
const shortcutSendInput = requireElement<HTMLInputElement>('#shortcut-send');
const shortcutNewSessionInput = requireElement<HTMLInputElement>('#shortcut-new-session');

let projects: ProjectState[] = [];
let activeProjectId = '';
let activeSessionId = '';
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let activeChart: Chart | null = null;
let lastParseMs = 0;
let authGateState: AuthGateState = { checking: true, status: null };
let desktopApiCache: Partial<DocumentPilotApi> | null = null;

const sessionInputs = new Map<string, SelectedInput>();

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ');
}

function toNumber(value: Cell): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const maybe = Number(value);
    if (Number.isFinite(maybe)) return maybe;
  }
  return undefined;
}

function toLabel(value: Cell, fallback: string): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function detectColumn(headers: string[], aliases: string[]): string | undefined {
  const normalized = headers.map((header) => ({ header, normalized: normalize(header) }));

  for (const alias of aliases) {
    const exact = normalized.find((item) => item.normalized === normalize(alias));
    if (exact) return exact.header;
  }

  for (const alias of aliases) {
    const partial = normalized.find((item) => item.normalized.includes(normalize(alias)));
    if (partial) return partial.header;
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

  if (!worksheet) {
    throw new Error('Excel workbook does not contain a non-empty sheet.');
  }

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
  return (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xlsm') ||
    file.type.includes('spreadsheetml') ||
    file.type.includes('excel')
  );
}

function isPdfFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  return lower.endsWith('.pdf') || file.type === 'application/pdf';
}

async function parseDataset(file: File): Promise<Dataset> {
  return isExcelFile(file) ? parseExcel(file) : parseCsv(file);
}

function buildSummary(dataset: Dataset): DatasetSummary {
  const sampleRows = dataset.rows.slice(0, 30).map((row) => {
    const output: Record<string, string | number | null> = {};

    for (const header of dataset.headers) {
      const value = row[header];
      if (typeof value === 'number' && Number.isFinite(value)) output[header] = value;
      else if (value === null || value === undefined || value === '') output[header] = null;
      else output[header] = String(value);
    }

    return output;
  });

  return {
    headers: dataset.headers,
    rowCount: dataset.rows.length,
    sampleRows,
    numericColumns: dataset.numericColumns
  };
}

function buildPoints(dataset: Dataset, plan: VisualizationPlan): Point[] {
  const points: Point[] = [];
  const xField = plan.xField;

  if (plan.derivedMetric === 'goal_difference') {
    const goalsFor = detectColumn(dataset.headers, GOALS_FOR_ALIASES);
    const goalsAgainst = detectColumn(dataset.headers, GOALS_AGAINST_ALIASES);

    if (!goalsFor || !goalsAgainst) {
      throw new Error('Goal difference requested, but goal columns were not found in the dataset.');
    }

    for (let i = 0; i < dataset.rows.length; i += 1) {
      const row = dataset.rows[i];
      const gf = toNumber(row[goalsFor]);
      const ga = toNumber(row[goalsAgainst]);
      if (gf === undefined || ga === undefined) continue;
      points.push({ label: toLabel(row[xField], `Row ${i + 1}`), value: gf - ga });
    }
  } else {
    if (!plan.yField) {
      throw new Error('No numeric field selected for plotting.');
    }

    for (let i = 0; i < dataset.rows.length; i += 1) {
      const row = dataset.rows[i];
      const value = toNumber(row[plan.yField]);
      if (value === undefined) continue;
      points.push({ label: toLabel(row[xField], `Row ${i + 1}`), value });
    }
  }

  if (plan.sort === 'asc') points.sort((a, b) => a.value - b.value);
  if (plan.sort === 'desc') points.sort((a, b) => b.value - a.value);

  return points.slice(0, plan.maxPoints);
}

function palette(size: number, alpha: number): string[] {
  const colors: string[] = [];
  for (let i = 0; i < size; i += 1) {
    const hue = Math.round((360 / Math.max(1, size)) * i);
    colors.push(`hsla(${hue}, 72%, 48%, ${alpha})`);
  }
  return colors;
}

function renderChart(plan: VisualizationPlan, points: Point[]): void {
  if (activeChart) {
    activeChart.destroy();
    activeChart = null;
  }

  chartPanelEl.classList.remove('hidden');

  const labels = points.map((point) => point.label);
  const values = points.map((point) => point.value);
  const datasetLabel = plan.derivedMetric === 'goal_difference' ? 'Goal Difference' : plan.yField ?? 'Value';
  const colors = palette(values.length, 0.75);
  const borders = palette(values.length, 1);

  const config: ChartConfiguration = {
    type: plan.chartType,
    data: {
      labels,
      datasets: [
        {
          label: datasetLabel,
          data: values,
          backgroundColor: plan.chartType === 'line' ? 'hsla(198, 86%, 45%, 0.2)' : colors,
          borderColor: plan.chartType === 'line' ? 'hsl(198, 86%, 35%)' : borders,
          borderWidth: 2,
          tension: plan.chartType === 'line' ? 0.22 : 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      plugins: {
        title: {
          display: true,
          text: plan.title
        }
      },
      scales:
        plan.chartType === 'bar' || plan.chartType === 'line'
          ? {
              x: { ticks: { maxRotation: 40, minRotation: 0, autoSkip: true } },
              y: { beginAtZero: false }
            }
          : undefined
    }
  };

  activeChart = new Chart(chartCanvas, config);
}

function clearChart(): void {
  if (activeChart) {
    activeChart.destroy();
    activeChart = null;
  }
  chartPanelEl.classList.add('hidden');
}

function buildDatasetInsight(points: Point[], result: AnalyzeDatasetResponse): string {
  if (points.length === 0) return 'No plottable rows were found after parsing and filtering.';

  const top = points[0];
  const bottom = points[points.length - 1];

  return [
    `Chart: ${result.plan.title}`,
    `Reason: ${result.plan.reason}`,
    `Top: ${top.label} (${top.value.toFixed(2)})`,
    `Bottom: ${bottom.label} (${bottom.value.toFixed(2)})`,
    result.warning ? `Warning: ${result.warning}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function buildPdfInsight(result: AnalyzePdfResponse): string {
  return [
    result.analysis,
    '',
    `Pages: ${result.pageCount} | Extracted chars: ${result.extractedChars}`,
    result.warning ? `Warning: ${result.warning}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function setMetrics(message: string): void {
  metricsEl.textContent = message;
}

async function resolveDesktopApi(timeoutMs = 1500): Promise<Partial<DocumentPilotApi> | null> {
  if (desktopApiCache) {
    return desktopApiCache;
  }

  const startedAt = performance.now();
  while (performance.now() - startedAt <= timeoutMs) {
    const candidate = (window as Window & { documentPilot?: Partial<DocumentPilotApi> }).documentPilot;
    if (candidate) {
      desktopApiCache = candidate;
      return candidate;
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 40);
    });
  }

  return null;
}

function getAuthBlockReason(status: CopilotAuthStatusResponse | null): string | null {
  if (!status) return 'Checking GitHub authentication...';
  if (!status.ok) return `Copilot SDK unavailable: ${status.statusMessage}`;
  if (!status.isAuthenticated) return status.statusMessage;
  if (status.modelAvailable === false) {
    return `Model "${status.model}" is not available for this account.`;
  }
  return null;
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
    if (announceSuccess) {
      setStatus('Bridge compatibility mode: auth will be validated when sending a request.');
    }
    return true;
  }

  try {
    const status = await api.getCopilotAuthStatus({
      model: settings.model
    });
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
    if (announceSuccess) {
      setStatus(`Authenticated as ${authGateState.status?.login ?? 'user'}.`);
    }
    return true;
  }

  setStatus(reason);
  return false;
}

async function ensureAuthReady(): Promise<boolean> {
  if (authGateState.checking) {
    return false;
  }

  if (!getAuthBlockReason(authGateState.status)) {
    return true;
  }

  return refreshAuthStatus(false);
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function messageHtml(message: ChatMessage): string {
  const cls = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system';
  const meta = message.meta ? `<div class="msg-meta">${escapeHtml(message.meta)}</div>` : '';
  return `<article class="msg ${cls}">${escapeHtml(message.content)}${meta}</article>`;
}

function saveState(): void {
  const payload: PersistedState = {
    projects,
    activeProjectId,
    activeSessionId,
    settings
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function newSession(title = 'New Session'): SessionState {
  return {
    id: uid('session'),
    title,
    messages: [],
    lastUpdated: Date.now()
  };
}

function newProject(name = 'Untitled Project'): ProjectState {
  const session = newSession();
  return {
    id: uid('project'),
    name,
    sessions: [session],
    createdAt: Date.now()
  };
}

function initializeState(): void {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const project = newProject('Document Pilot');
    projects = [project];
    activeProjectId = project.id;
    activeSessionId = project.sessions[0].id;
    settings = { ...DEFAULT_SETTINGS };
    return;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    projects = Array.isArray(parsed.projects) && parsed.projects.length > 0 ? parsed.projects : [newProject('Document Pilot')];
    activeProjectId = typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : projects[0].id;

    const project = projects.find((item) => item.id === activeProjectId) ?? projects[0];
    activeProjectId = project.id;
    activeSessionId =
      typeof parsed.activeSessionId === 'string' && project.sessions.some((item) => item.id === parsed.activeSessionId)
        ? parsed.activeSessionId
        : project.sessions[0]?.id;

    if (!activeSessionId) {
      const session = newSession();
      project.sessions.push(session);
      activeSessionId = session.id;
    }

    settings = {
      model: typeof parsed.settings?.model === 'string' && parsed.settings.model.trim() ? parsed.settings.model : DEFAULT_SETTINGS.model,
      reasoningEffort:
        parsed.settings?.reasoningEffort === 'low' ||
        parsed.settings?.reasoningEffort === 'medium' ||
        parsed.settings?.reasoningEffort === 'high' ||
        parsed.settings?.reasoningEffort === 'xhigh'
          ? parsed.settings.reasoningEffort
          : DEFAULT_SETTINGS.reasoningEffort,
      shortcuts: {
        sendMessage:
          typeof parsed.settings?.shortcuts?.sendMessage === 'string' && parsed.settings.shortcuts.sendMessage.trim()
            ? parsed.settings.shortcuts.sendMessage
            : DEFAULT_SETTINGS.shortcuts.sendMessage,
        newSession:
          typeof parsed.settings?.shortcuts?.newSession === 'string' && parsed.settings.shortcuts.newSession.trim()
            ? parsed.settings.shortcuts.newSession
            : DEFAULT_SETTINGS.shortcuts.newSession
      }
    };
  } catch {
    const project = newProject('Document Pilot');
    projects = [project];
    activeProjectId = project.id;
    activeSessionId = project.sessions[0].id;
    settings = { ...DEFAULT_SETTINGS };
  }
}

function getActiveProject(): ProjectState {
  const project = projects.find((item) => item.id === activeProjectId);
  if (!project) {
    const fallback = projects[0] ?? newProject('Document Pilot');
    if (projects.length === 0) projects.push(fallback);
    activeProjectId = fallback.id;
    return fallback;
  }
  return project;
}

function getActiveSession(): SessionState {
  const project = getActiveProject();
  const session = project.sessions.find((item) => item.id === activeSessionId);
  if (!session) {
    const fallback = project.sessions[0] ?? newSession();
    if (project.sessions.length === 0) project.sessions.push(fallback);
    activeSessionId = fallback.id;
    return fallback;
  }
  return session;
}

function updateRuntimeChips(): void {
  modelChipEl.textContent = `Model: ${settings.model}`;
  reasoningChipEl.textContent = `Reasoning: ${settings.reasoningEffort}`;
  runtimeIndicatorEl.textContent = `Model: ${settings.model} | Reasoning: ${settings.reasoningEffort}`;
}

function setSessionInput(input: SelectedInput | null): void {
  if (input) sessionInputs.set(activeSessionId, input);
  else sessionInputs.delete(activeSessionId);

  const current = sessionInputs.get(activeSessionId) ?? null;
  fileChipEl.textContent = current ? current.fileName : 'No file attached';
}

function applySessionContext(): void {
  const project = getActiveProject();
  const session = getActiveSession();

  sessionTitleEl.textContent = session.title;
  sessionSubtitleEl.textContent = `${project.name} • ${session.messages.length} messages`;

  const selectedInput = sessionInputs.get(activeSessionId) ?? null;
  fileChipEl.textContent = selectedInput ? selectedInput.fileName : 'No file attached';

  chatLogEl.innerHTML = '';
  if (session.messages.length === 0) {
    chatLogEl.innerHTML = '<article class="msg assistant">Attach a CSV, Excel, or PDF file and ask your first question.</article>';
  } else {
    chatLogEl.innerHTML = session.messages.map((item) => messageHtml(item)).join('');
  }
  chatLogEl.scrollTop = chatLogEl.scrollHeight;

  if (session.chart) {
    renderChart(session.chart.plan, session.chart.points);
  } else {
    clearChart();
  }

  renderProjectList();
}

function renderProjectList(): void {
  const currentProjectId = activeProjectId;
  const currentSessionId = activeSessionId;

  projectListEl.innerHTML = projects
    .map((project) => {
      const sessionsHtml = project.sessions
        .map((session) => {
          const activeClass = session.id === currentSessionId ? 'active' : '';
          return [
            `<button class="session-btn ${activeClass}" data-action="switch-session" data-project-id="${project.id}" data-session-id="${session.id}">`,
            `<span>${escapeHtml(session.title)}</span>`,
            `<span class="session-time">${formatRelativeTime(session.lastUpdated)}</span>`,
            '</button>'
          ].join('');
        })
        .join('');

      return [
        `<div class="project-card" data-project-id="${project.id}">`,
        '<div class="project-head">',
        `<button class="project-title-btn" data-action="switch-project" data-project-id="${project.id}">${escapeHtml(project.name)}</button>`,
        '<div class="project-tools">',
        `<button class="ghost" data-action="new-session" data-project-id="${project.id}" type="button">+ Session</button>`,
        '</div>',
        '</div>',
        `<div class="session-list" ${project.id === currentProjectId ? '' : 'style="display:none"'}>${sessionsHtml}</div>`,
        '</div>'
      ].join('');
    })
    .join('');
}

function addMessage(role: ChatMessage['role'], content: string, meta?: string): void {
  const session = getActiveSession();
  session.messages.push({
    id: uid('msg'),
    role,
    content,
    createdAt: Date.now(),
    meta
  });
  session.lastUpdated = Date.now();

  if (session.title === 'New Session' && role === 'user') {
    session.title = content.slice(0, 42).trim() || 'New Session';
  }

  saveState();
  applySessionContext();
}

function createProject(): void {
  const name = window.prompt('Project name', 'New Project')?.trim();
  if (!name) return;

  const project = newProject(name);
  projects.unshift(project);
  activeProjectId = project.id;
  activeSessionId = project.sessions[0].id;
  saveState();
  applySessionContext();
}

function createSession(projectId: string): void {
  const project = projects.find((item) => item.id === projectId);
  if (!project) return;
  const session = newSession();
  project.sessions.unshift(session);
  activeProjectId = project.id;
  activeSessionId = session.id;
  setStatus('New session created.');
  saveState();
  applySessionContext();
}

function switchProject(projectId: string): void {
  const project = projects.find((item) => item.id === projectId);
  if (!project) return;
  activeProjectId = project.id;
  activeSessionId = project.sessions[0]?.id ?? activeSessionId;
  saveState();
  applySessionContext();
}

function switchSession(projectId: string, sessionId: string): void {
  const project = projects.find((item) => item.id === projectId);
  if (!project || !project.sessions.some((item) => item.id === sessionId)) return;
  activeProjectId = project.id;
  activeSessionId = sessionId;
  saveState();
  applySessionContext();
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

  const eventKey = event.key.toLowerCase();
  const normalizedKey = eventKey === 'return' ? 'enter' : eventKey;

  return (
    normalizedKey === shortcut.key &&
    event.metaKey === shortcut.meta &&
    event.shiftKey === shortcut.shift &&
    event.altKey === shortcut.alt &&
    event.ctrlKey === shortcut.ctrl
  );
}

function openSettings(): void {
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

  settings = {
    model,
    reasoningEffort: reasoning,
    shortcuts: {
      sendMessage: sendShortcut,
      newSession: newSessionShortcut
    }
  };

  updateRuntimeChips();
  saveState();
  setStatus('Settings saved.');
  closeSettings();
  void refreshAuthStatus(false);
}

async function handleFileAttach(): Promise<void> {
  if (!(await ensureAuthReady())) {
    fileInput.value = '';
    return;
  }

  const file = fileInput.files?.[0];
  if (!file) return;

  sendButton.disabled = true;
  setStatus(`Loading ${file.name}...`);

  const startedAt = performance.now();

  try {
    if (isPdfFile(file)) {
      setSessionInput({ kind: 'pdf', file, fileName: file.name });
      clearChart();
      const session = getActiveSession();
      session.chart = undefined;
      lastParseMs = Number((performance.now() - startedAt).toFixed(2));
      setMetrics(`File: ${file.name} | Prepare: ${lastParseMs}ms`);
      setStatus('PDF attached. Ask a question.');
      saveState();
      return;
    }

    const dataset = await parseDataset(file);
    setSessionInput({ kind: 'tabular', dataset, fileName: file.name });
    lastParseMs = Number((performance.now() - startedAt).toFixed(2));
    setMetrics(`File: ${file.name} | Parse: ${lastParseMs}ms | Rows: ${dataset.rows.length}`);
    setStatus(`Loaded ${dataset.rows.length} rows and ${dataset.headers.length} columns.`);
  } catch (error) {
    setSessionInput(null);
    setStatus(`Attach failed: ${(error as Error).message}`);
  } finally {
    sendButton.disabled = false;
    fileInput.value = '';
  }
}

async function sendPrompt(): Promise<void> {
  if (!(await ensureAuthReady())) {
    return;
  }

  const prompt = promptInput.value.trim();
  if (!prompt) {
    setStatus('Enter a prompt first.');
    return;
  }

  const selectedInput = sessionInputs.get(activeSessionId);
  if (!selectedInput) {
    setStatus('Attach a CSV, Excel, or PDF file first.');
    return;
  }

  const api = await resolveDesktopApi();
  if (!api) {
    setStatus('Desktop bridge unavailable. Restart the app and try again.');
    return;
  }

  sendButton.disabled = true;
  promptInput.disabled = true;

  const startedAt = performance.now();
  const assistantMetaBase = `${settings.model} • ${settings.reasoningEffort}`;
  addMessage('user', prompt, selectedInput.fileName);

  try {
    if (selectedInput.kind === 'tabular') {
      setStatus('Planning chart and response...');

      const summary = buildSummary(selectedInput.dataset);
      if (typeof api.analyzeDataset !== 'function') {
        throw new Error('Desktop API analyzeDataset is unavailable in this runtime.');
      }
      const response = await api.analyzeDataset({
        prompt,
        dataset: summary,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort
      });

      const points = buildPoints(selectedInput.dataset, response.plan);
      const renderStart = performance.now();
      renderChart(response.plan, points);
      const renderMs = Number((performance.now() - renderStart).toFixed(2));

      const session = getActiveSession();
      session.chart = { plan: response.plan, points };
      session.lastUpdated = Date.now();

      const content = buildDatasetInsight(points, response);
      addMessage('assistant', content, `${assistantMetaBase} • ${response.source}`);

      setMetrics(
        `File: ${selectedInput.fileName} | Rows: ${summary.rowCount} | Parse: ${lastParseMs}ms | AI: ${response.latencyMs}ms | Render: ${renderMs}ms | Total: ${Number((performance.now() - startedAt).toFixed(2))}ms`
      );
      setStatus('Analysis complete.');
      saveState();
    } else {
      setStatus('Extracting and analyzing PDF...');

      clearChart();
      const pdfData = await selectedInput.file.arrayBuffer();
      if (typeof api.analyzePdf !== 'function') {
        throw new Error('Desktop API analyzePdf is unavailable in this runtime.');
      }
      const response = await api.analyzePdf({
        prompt,
        fileName: selectedInput.fileName,
        pdfData,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort
      });

      const session = getActiveSession();
      session.chart = undefined;
      session.lastUpdated = Date.now();

      addMessage('assistant', buildPdfInsight(response), `${assistantMetaBase} • ${response.source}`);
      setMetrics(
        `File: ${selectedInput.fileName} | Prepare: ${lastParseMs}ms | PDF: ${response.latencyMs}ms | Total: ${Number((performance.now() - startedAt).toFixed(2))}ms`
      );
      setStatus('PDF analysis complete.');
      saveState();
    }
  } catch (error) {
    addMessage('assistant', `Analysis failed: ${(error as Error).message}`, assistantMetaBase);
    setStatus(`Analysis failed: ${(error as Error).message}`);
  } finally {
    sendButton.disabled = false;
    promptInput.disabled = false;
    promptInput.focus();
  }
}

function attachEventHandlers(): void {
  attachFileButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    void handleFileAttach();
  });

  sendButton.addEventListener('click', () => {
    void sendPrompt();
  });

  projectListEl.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;

    const action = target.getAttribute('data-action');
    const projectId = target.getAttribute('data-project-id') ?? '';
    const sessionId = target.getAttribute('data-session-id') ?? '';

    if (action === 'switch-project') {
      switchProject(projectId);
      return;
    }

    if (action === 'new-session') {
      createSession(projectId);
      return;
    }

    if (action === 'switch-session') {
      switchSession(projectId, sessionId);
    }
  });

  newProjectButton.addEventListener('click', () => createProject());

  openSettingsButton.addEventListener('click', () => openSettings());
  closeSettingsButton.addEventListener('click', () => closeSettings());
  saveSettingsButton.addEventListener('click', () => saveSettings());
  recheckAuthButton.addEventListener('click', () => {
    void refreshAuthStatus(true);
  });

  settingsModalEl.addEventListener('click', (event) => {
    if (event.target === settingsModalEl) {
      closeSettings();
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !settingsModalEl.classList.contains('hidden')) {
      closeSettings();
      return;
    }

    if (!settingsModalEl.classList.contains('hidden')) {
      return;
    }

    if (shortcutMatches(event, settings.shortcuts.sendMessage)) {
      event.preventDefault();
      void sendPrompt();
      return;
    }

    if (shortcutMatches(event, settings.shortcuts.newSession)) {
      event.preventDefault();
      createSession(activeProjectId);
    }
  });
}

function boot(): void {
  initializeState();
  updateRuntimeChips();
  attachEventHandlers();
  setStatus('Checking GitHub authentication...');
  setMetrics('');
  applySessionContext();
  void refreshAuthStatus(false);
}

boot();
