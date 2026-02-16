import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppState,
  AppSettings,
  DocumentKind,
  ProjectMetadata,
  StoredDocument,
  ThreadMetadata
} from '../shared/contracts.js';

const DEBOUNCE_MS = 500;

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

function inferDocumentKind(fileName: string): DocumentKind {
  return fileName.toLowerCase().endsWith('.pdf') ? 'pdf' : 'tabular';
}

export class ProjectStorage {
  private baseDir: string;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingWrites = new Map<string, { filePath: string; data: string }>();

  constructor() {
    this.baseDir = path.join(app.getPath('userData'), 'document-pilot-data');
  }

  // ── Directory helpers ───────────────────────────────────────────

  private get appStatePath(): string {
    return path.join(this.baseDir, 'app-state.json');
  }

  private projectDir(projectId: string): string {
    return path.join(this.baseDir, 'projects', sanitizeFileName(projectId));
  }

  private projectJsonPath(projectId: string): string {
    return path.join(this.projectDir(projectId), 'project.json');
  }

  private projectDocsDir(projectId: string): string {
    return path.join(this.projectDir(projectId), 'documents');
  }

  private threadDocsDir(threadId: string): string {
    return path.join(this.baseDir, 'threads', sanitizeFileName(threadId), 'documents');
  }

  private resolveDocsDir(targetId: string, isThread: boolean): string {
    return isThread ? this.threadDocsDir(targetId) : this.projectDocsDir(targetId);
  }

  // ── Atomic write ────────────────────────────────────────────────

  private async atomicWrite(filePath: string, data: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    await fs.writeFile(tmp, data, 'utf-8');
    await fs.rename(tmp, filePath);
  }

  // ── Debounced write ─────────────────────────────────────────────

  private debouncedWrite(key: string, filePath: string, data: string): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.pendingWrites.set(key, { filePath, data });

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        this.pendingWrites.delete(key);
        this.atomicWrite(filePath, data).catch((err) => {
          console.error(`[ProjectStorage] debounced write failed for ${key}:`, err);
        });
      }, DEBOUNCE_MS)
    );
  }

  // ── App State ───────────────────────────────────────────────────

  async loadAppState(): Promise<AppState | null> {
    try {
      const raw = await fs.readFile(this.appStatePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;

      // Auto-migrate old AppState field names
      if ('globalThreads' in data && !('threads' in data)) {
        data.threads = data.globalThreads;
        delete data.globalThreads;
      }
      if ('activeSessionId' in data && !('activeThreadId' in data)) {
        data.activeThreadId = data.activeSessionId;
        delete data.activeSessionId;
      }
      // Migrate shortcut name
      const settings = data.settings as Record<string, unknown> | undefined;
      if (settings) {
        const shortcuts = settings.shortcuts as Record<string, unknown> | undefined;
        if (shortcuts && 'newSession' in shortcuts && !('newThread' in shortcuts)) {
          shortcuts.newThread = shortcuts.newSession;
          delete shortcuts.newSession;
        }
      }

      return data as unknown as AppState;
    } catch {
      return null;
    }
  }

  saveAppState(state: AppState): void {
    this.debouncedWrite('app-state', this.appStatePath, JSON.stringify(state, null, 2));
  }

  // ── Projects ────────────────────────────────────────────────────

  async loadProject(projectId: string): Promise<ProjectMetadata | null> {
    try {
      const raw = await fs.readFile(this.projectJsonPath(projectId), 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;

      // Auto-migrate: sessions → threads
      if ('sessions' in data && !('threads' in data)) {
        const sessions = data.sessions as Array<Record<string, unknown>>;
        data.threads = sessions.map((s) => ({ ...s, documents: [] }));
        delete data.sessions;
        // Persist the migrated data
        await this.atomicWrite(this.projectJsonPath(projectId), JSON.stringify(data, null, 2));
      }

      return data as unknown as ProjectMetadata;
    } catch {
      return null;
    }
  }

  saveProject(project: ProjectMetadata): void {
    this.debouncedWrite(
      `project:${project.id}`,
      this.projectJsonPath(project.id),
      JSON.stringify(project, null, 2)
    );
  }

  async deleteProject(projectId: string): Promise<void> {
    const dir = this.projectDir(projectId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // ── Documents ───────────────────────────────────────────────────

  async copyDocument(
    targetId: string,
    documentId: string,
    originalFileName: string,
    fileData: Buffer
  ): Promise<StoredDocument> {
    const isThread = targetId.startsWith('thread-');
    const docsDir = this.resolveDocsDir(targetId, isThread);
    await fs.mkdir(docsDir, { recursive: true });

    const storedFileName = `${sanitizeFileName(documentId)}-${sanitizeFileName(originalFileName)}`;
    const dest = path.join(docsDir, storedFileName);
    await fs.writeFile(dest, fileData);

    return {
      id: documentId,
      originalFileName,
      storedFileName,
      kind: inferDocumentKind(originalFileName),
      sizeBytes: fileData.byteLength,
      addedAt: Date.now()
    };
  }

  async readDocument(
    targetId: string,
    storedFileName: string
  ): Promise<{ fileData: Buffer; originalFileName: string; kind: DocumentKind }> {
    const isThread = targetId.startsWith('thread-');
    const docsDir = this.resolveDocsDir(targetId, isThread);
    const safeName = sanitizeFileName(storedFileName);
    const filePath = path.join(docsDir, safeName);

    const fileData = await fs.readFile(filePath);
    // Extract original name: strip the leading "docId-" prefix
    const dashIndex = safeName.indexOf('-');
    const originalFileName = dashIndex >= 0 ? storedFileName.slice(dashIndex + 1) : storedFileName;

    return {
      fileData,
      originalFileName,
      kind: inferDocumentKind(originalFileName)
    };
  }

  async deleteDocument(targetId: string, storedFileName: string): Promise<void> {
    const isThread = targetId.startsWith('thread-');
    const docsDir = this.resolveDocsDir(targetId, isThread);
    const safeName = sanitizeFileName(storedFileName);
    await fs.rm(path.join(docsDir, safeName), { force: true });
  }

  // ── Legacy Migration ────────────────────────────────────────────

  async migrateLegacyState(legacyJson: string): Promise<AppState> {
    const legacy = JSON.parse(legacyJson) as {
      projects?: Array<{
        id: string;
        name: string;
        sessions: Array<{
          id: string;
          title: string;
          messages: Array<{
            id: string;
            role: 'user' | 'assistant' | 'system';
            content: string;
            createdAt: number;
            meta?: string;
          }>;
          lastUpdated: number;
        }>;
        createdAt: number;
      }>;
      activeProjectId?: string;
      activeSessionId?: string;
      settings?: AppSettings;
    };

    const projects = legacy.projects ?? [];
    const projectIndex: AppState['projectIndex'] = [];
    const now = Date.now();

    for (const p of projects) {
      const meta: ProjectMetadata = {
        id: p.id,
        name: p.name,
        documents: [],
        threads: p.sessions.map((s) => ({
          id: s.id,
          title: s.title,
          messages: s.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
            meta: m.meta
          })),
          documents: [],
          activeDocumentId: null,
          lastUpdated: s.lastUpdated
        })),
        createdAt: p.createdAt,
        updatedAt: now
      };

      await fs.mkdir(this.projectDocsDir(p.id), { recursive: true });
      await this.atomicWrite(this.projectJsonPath(p.id), JSON.stringify(meta, null, 2));

      projectIndex.push({ id: p.id, name: p.name, updatedAt: now });
    }

    const defaultSettings: AppSettings = {
      model: 'gpt-5-mini',
      reasoningEffort: 'high',
      shortcuts: { sendMessage: 'Meta+Enter', newThread: 'Meta+Shift+N' }
    };

    const appState: AppState = {
      projectIndex,
      threads: [],
      activeProjectId: legacy.activeProjectId ?? projects[0]?.id ?? null,
      activeThreadId: legacy.activeSessionId ?? projects[0]?.sessions[0]?.id ?? '',
      settings: legacy.settings ?? defaultSettings
    };

    await this.atomicWrite(this.appStatePath, JSON.stringify(appState, null, 2));
    return appState;
  }

  // ── Flush pending writes (call before quit) ─────────────────────

  async flush(): Promise<void> {
    const writes: Promise<void>[] = [];

    for (const [key, timer] of this.debounceTimers) {
      clearTimeout(timer);
      const pending = this.pendingWrites.get(key);
      if (pending) {
        writes.push(this.atomicWrite(pending.filePath, pending.data));
      }
    }

    this.debounceTimers.clear();
    this.pendingWrites.clear();
    await Promise.all(writes);
  }
}
