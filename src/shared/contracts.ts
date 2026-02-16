export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type DocumentKind = 'tabular' | 'pdf';

export interface DatasetSummary {
  headers: string[];
  rowCount: number;
  sampleRows: Array<Record<string, string | number | null>>;
  numericColumns: string[];
}

export interface DocumentContext {
  kind: DocumentKind;
  fileName: string;
  textContent: string;
  pdfData?: ArrayBuffer;
  rowCount?: number;
  pageCount?: number;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  prompt: string;
  document: DocumentContext;
  history?: ConversationMessage[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ChatResponse {
  answer: string;
  source: 'copilot' | 'fallback';
  model: string;
  latencyMs: number;
  warning?: string;
}

export interface CopilotAuthStatusRequest {
  model?: string;
}

export interface CopilotAuthStatusResponse {
  ok: boolean;
  isAuthenticated: boolean;
  authType?: 'user' | 'env' | 'gh-cli' | 'hmac' | 'api-key' | 'token';
  login?: string;
  host?: string;
  statusMessage: string;
  model: string;
  modelAvailable?: boolean;
  checkedAt: number;
}

// ── Project Management Types ────────────────────────────────────────

export interface StoredDocument {
  id: string;
  originalFileName: string;
  storedFileName: string;
  kind: DocumentKind;
  sizeBytes: number;
  addedAt: number;
}

export interface ChatMessageData {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  meta?: string;
}

export interface ThreadMetadata {
  id: string;
  title: string;
  messages: ChatMessageData[];
  documents: StoredDocument[];
  activeDocumentId: string | null;
  lastUpdated: number;
}

export interface ProjectMetadata {
  id: string;
  name: string;
  documents: StoredDocument[];
  threads: ThreadMetadata[];
  createdAt: number;
  updatedAt: number;
}

export interface KeyboardShortcuts {
  sendMessage: string;
  newThread: string;
}

export interface AppSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
  shortcuts: KeyboardShortcuts;
}

export interface AppState {
  projectIndex: Array<{ id: string; name: string; updatedAt: number }>;
  threads: ThreadMetadata[];
  activeProjectId: string | null;
  activeThreadId: string;
  settings: AppSettings;
}

// ── IPC Request/Response Types ──────────────────────────────────────

export interface SaveAppStateRequest { state: AppState; }
export interface LoadProjectRequest { projectId: string; }
export interface LoadProjectResponse { project: ProjectMetadata | null; }
export interface SaveProjectRequest { project: ProjectMetadata; }
export interface CopyDocumentRequest {
  targetId: string;
  documentId: string;
  originalFileName: string;
  fileData: ArrayBuffer;
}
export interface CopyDocumentResponse { storedDocument: StoredDocument; }
export interface ReadDocumentRequest { targetId: string; storedFileName: string; }
export interface ReadDocumentResponse { fileData: ArrayBuffer; originalFileName: string; kind: DocumentKind; }
export interface DeleteDocumentRequest { targetId: string; documentId: string; storedFileName: string; }
export interface DeleteProjectRequest { projectId: string; }
export interface MigrateStateRequest { legacyState: string; }
export interface MigrateStateResponse { success: boolean; appState: AppState; }
