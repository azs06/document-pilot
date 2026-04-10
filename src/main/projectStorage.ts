import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppSettings,
  AppState,
  AttachmentRecord,
  KeyboardShortcuts,
  SessionRecord,
  TaskRecord,
  TaskRun,
  WorkspaceMetadata
} from '../shared/contracts.js';

const DEBOUNCE_MS = 500;

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

function inferMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function migrateShortcuts(input: Record<string, unknown> | undefined): KeyboardShortcuts {
  return {
    sendMessage: typeof input?.sendMessage === 'string' ? input.sendMessage : 'Meta+Enter',
    newSession:
      typeof input?.newSession === 'string'
        ? input.newSession
        : typeof input?.newThread === 'string'
          ? input.newThread
          : typeof input?.newSession === 'string'
            ? input.newSession
            : 'Meta+Shift+N'
  };
}

function migrateSettings(input: unknown): AppSettings {
  const source = (input ?? {}) as Record<string, unknown>;
  return {
    model: typeof source.model === 'string' && source.model.trim() ? source.model : 'gpt-5-mini',
    reasoningEffort:
      source.reasoningEffort === 'low' ||
      source.reasoningEffort === 'medium' ||
      source.reasoningEffort === 'high' ||
      source.reasoningEffort === 'xhigh'
        ? source.reasoningEffort
        : 'high',
    shortcuts: migrateShortcuts(source.shortcuts as Record<string, unknown> | undefined)
  };
}

type LegacyMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  meta?: string;
};

type LegacyStoredDocument = {
  id: string;
  originalFileName: string;
  storedFileName: string;
  sizeBytes: number;
  addedAt: number;
};

type LegacyThread = {
  id: string;
  title: string;
  messages: LegacyMessage[];
  documents?: LegacyStoredDocument[];
  activeDocumentId?: string | null;
  lastUpdated: number;
};

type LegacyProject = {
  id: string;
  name: string;
  documents?: LegacyStoredDocument[];
  threads?: LegacyThread[];
  sessions?: LegacyThread[];
  createdAt: number;
  updatedAt?: number;
};

export class ProjectStorage {
  private baseDir: string;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingWrites = new Map<string, { filePath: string; data: string }>();

  constructor() {
    this.baseDir = path.join(app.getPath('userData'), 'document-pilot-data');
  }

  private get appStatePath(): string {
    return path.join(this.baseDir, 'app-state.json');
  }

  private workspaceDir(workspaceId: string): string {
    return path.join(this.baseDir, 'workspaces', sanitizeFileName(workspaceId));
  }

  private workspaceJsonPath(workspaceId: string): string {
    return path.join(this.workspaceDir(workspaceId), 'workspace.json');
  }

  private legacyWorkspaceJsonPath(workspaceId: string): string {
    return path.join(this.workspaceDir(workspaceId), 'project.json');
  }

  private workspaceAttachmentsDir(workspaceId: string): string {
    return path.join(this.workspaceDir(workspaceId), 'attachments');
  }

  private sessionAttachmentsDir(sessionId: string): string {
    return path.join(this.baseDir, 'sessions', sanitizeFileName(sessionId), 'attachments');
  }

  private resolveAttachmentsDir(targetId: string): string {
    const isSession = targetId.startsWith('session-') || targetId.startsWith('thread-');
    return isSession ? this.sessionAttachmentsDir(targetId) : this.workspaceAttachmentsDir(targetId);
  }

  private async atomicWrite(filePath: string, data: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    await fs.writeFile(tmp, data, 'utf-8');
    await fs.rename(tmp, filePath);
  }

  private debouncedWrite(key: string, filePath: string, data: string): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.pendingWrites.set(key, { filePath, data });

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        this.pendingWrites.delete(key);
        this.atomicWrite(filePath, data).catch((error) => {
          console.error(`[WorkspaceStorage] debounced write failed for ${key}:`, error);
        });
      }, DEBOUNCE_MS)
    );
  }

  private attachmentFromLegacy(document: LegacyStoredDocument): AttachmentRecord {
    return {
      id: document.id,
      originalFileName: document.originalFileName,
      storedFileName: document.storedFileName,
      mimeType: inferMimeType(document.originalFileName),
      sizeBytes: document.sizeBytes,
      addedAt: document.addedAt
    };
  }

  private buildImportedRun(outputs: LegacyMessage[], createdAt: number): TaskRun {
    const content = outputs.map((message) => message.content.trim()).filter(Boolean);
    return {
      id: randomUUID(),
      status: 'completed',
      model: 'legacy-import',
      latencyMs: 0,
      summary: content[0]?.slice(0, 160) || 'Imported conversation history.',
      plan: [],
      approvals: [],
      outputBlocks:
        content.length > 0
          ? content.map((message, index) => ({
              id: randomUUID(),
              type: 'markdown',
              title: index === 0 ? 'Imported response' : undefined,
              content: message
            }))
          : [
              {
                id: randomUUID(),
                type: 'status',
                title: 'Imported history',
                content: 'This task was imported from the previous document-centric app.'
              }
            ],
      artifacts: [],
      createdAt,
      startedAt: createdAt,
      completedAt: createdAt
    };
  }

  private tasksFromLegacyMessages(messages: LegacyMessage[]): TaskRecord[] {
    const tasks: TaskRecord[] = [];
    let pendingPrompt: LegacyMessage | null = null;
    let pendingOutputs: LegacyMessage[] = [];

    const flush = () => {
      if (!pendingPrompt && pendingOutputs.length === 0) return;
      const createdAt = pendingPrompt?.createdAt ?? pendingOutputs[0]?.createdAt ?? Date.now();
      const prompt = pendingPrompt?.content?.trim() || 'Imported conversation';
      tasks.push({
        id: randomUUID(),
        prompt,
        createdAt,
        updatedAt: pendingOutputs.at(-1)?.createdAt ?? createdAt,
        runs: [this.buildImportedRun(pendingOutputs, createdAt)]
      });
      pendingPrompt = null;
      pendingOutputs = [];
    };

    for (const message of messages) {
      if (message.role === 'user') {
        flush();
        pendingPrompt = message;
      } else {
        pendingOutputs.push(message);
      }
    }

    flush();
    return tasks;
  }

  private sessionFromLegacyThread(thread: LegacyThread): SessionRecord {
    return {
      id: thread.id,
      title: thread.title,
      tasks: this.tasksFromLegacyMessages(thread.messages ?? []),
      attachments: (thread.documents ?? []).map((document) => this.attachmentFromLegacy(document)),
      lastUpdated: thread.lastUpdated
    };
  }

  private workspaceFromLegacyProject(project: LegacyProject): WorkspaceMetadata {
    const sessions = (project.threads ?? project.sessions ?? []).map((thread) => this.sessionFromLegacyThread(thread));

    if (sessions.length === 0) {
      sessions.push({
        id: `session-${sanitizeFileName(project.id)}-root`,
        title: 'General',
        tasks: [],
        attachments: [],
        lastUpdated: project.updatedAt ?? project.createdAt
      });
    }

    if (project.documents?.length) {
      sessions[0].attachments.unshift(...project.documents.map((document) => this.attachmentFromLegacy(document)));
    }

    return {
      id: project.id,
      name: project.name,
      sessions,
      permissionGrants: [],
      createdAt: project.createdAt,
      updatedAt: project.updatedAt ?? project.createdAt
    };
  }

  async loadAppState(): Promise<AppState | null> {
    try {
      const raw = await fs.readFile(this.appStatePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;

      if (Array.isArray(data.workspaceIndex)) {
        return {
          workspaceIndex: data.workspaceIndex as AppState['workspaceIndex'],
          activeWorkspaceId: typeof data.activeWorkspaceId === 'string' ? data.activeWorkspaceId : null,
          activeSessionId: typeof data.activeSessionId === 'string' ? data.activeSessionId : null,
          settings: migrateSettings(data.settings)
        };
      }

      if (!Array.isArray(data.projectIndex)) {
        return null;
      }

      const migratedState: AppState = {
        workspaceIndex: (data.projectIndex as Array<Record<string, unknown>>).map((entry) => ({
          id: String(entry.id),
          name: String(entry.name),
          updatedAt: Number(entry.updatedAt ?? Date.now())
        })),
        activeWorkspaceId: typeof data.activeProjectId === 'string' ? data.activeProjectId : null,
        activeSessionId: typeof data.activeThreadId === 'string' ? data.activeThreadId : null,
        settings: migrateSettings(data.settings)
      };

      const legacyThreads = Array.isArray(data.threads) ? (data.threads as LegacyThread[]) : [];
      if (legacyThreads.length > 0) {
        const importedWorkspaceId = 'workspace-imported-sessions';
        const alreadyExists = migratedState.workspaceIndex.some((entry) => entry.id === importedWorkspaceId);
        if (!alreadyExists) {
          const importedWorkspace: WorkspaceMetadata = {
            id: importedWorkspaceId,
            name: 'Imported Sessions',
            sessions: legacyThreads.map((thread) => this.sessionFromLegacyThread(thread)),
            permissionGrants: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
          };
          await this.atomicWrite(
            this.workspaceJsonPath(importedWorkspaceId),
            JSON.stringify(importedWorkspace, null, 2)
          );
          migratedState.workspaceIndex.unshift({
            id: importedWorkspaceId,
            name: importedWorkspace.name,
            updatedAt: importedWorkspace.updatedAt
          });
        }

        if (!migratedState.activeWorkspaceId) {
          migratedState.activeWorkspaceId = importedWorkspaceId;
          migratedState.activeSessionId = legacyThreads[0]?.id ?? null;
        }
      }

      await this.atomicWrite(this.appStatePath, JSON.stringify(migratedState, null, 2));
      return migratedState;
    } catch {
      return null;
    }
  }

  saveAppState(state: AppState): void {
    this.debouncedWrite('app-state', this.appStatePath, JSON.stringify(state, null, 2));
  }

  async loadWorkspace(workspaceId: string): Promise<WorkspaceMetadata | null> {
    try {
      const raw = await fs.readFile(this.workspaceJsonPath(workspaceId), 'utf-8');
      return JSON.parse(raw) as WorkspaceMetadata;
    } catch {
      try {
        const raw = await fs.readFile(this.legacyWorkspaceJsonPath(workspaceId), 'utf-8');
        const legacyProject = JSON.parse(raw) as LegacyProject;
        const migratedWorkspace = this.workspaceFromLegacyProject(legacyProject);
        await this.atomicWrite(
          this.workspaceJsonPath(workspaceId),
          JSON.stringify(migratedWorkspace, null, 2)
        );
        return migratedWorkspace;
      } catch {
        return null;
      }
    }
  }

  saveWorkspace(workspace: WorkspaceMetadata): void {
    this.debouncedWrite(
      `workspace:${workspace.id}`,
      this.workspaceJsonPath(workspace.id),
      JSON.stringify(workspace, null, 2)
    );
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await fs.rm(this.workspaceDir(workspaceId), { recursive: true, force: true });
  }

  async copyAttachment(
    targetId: string,
    attachmentId: string,
    originalFileName: string,
    mimeType: string,
    fileData: Buffer
  ): Promise<AttachmentRecord> {
    const attachmentsDir = this.resolveAttachmentsDir(targetId);
    await fs.mkdir(attachmentsDir, { recursive: true });

    const storedFileName = `${sanitizeFileName(attachmentId)}-${sanitizeFileName(originalFileName)}`;
    await fs.writeFile(path.join(attachmentsDir, storedFileName), fileData);

    return {
      id: attachmentId,
      originalFileName,
      storedFileName,
      mimeType: mimeType || inferMimeType(originalFileName),
      sizeBytes: fileData.byteLength,
      addedAt: Date.now()
    };
  }

  async readAttachment(
    targetId: string,
    storedFileName: string
  ): Promise<{ fileData: Buffer; originalFileName: string; mimeType: string }> {
    const attachmentsDir = this.resolveAttachmentsDir(targetId);
    const safeName = sanitizeFileName(storedFileName);
    const filePath = path.join(attachmentsDir, safeName);
    const fileData = await fs.readFile(filePath);
    const dashIndex = safeName.indexOf('-');
    const originalFileName = dashIndex >= 0 ? storedFileName.slice(dashIndex + 1) : storedFileName;

    return {
      fileData,
      originalFileName,
      mimeType: inferMimeType(originalFileName)
    };
  }

  async deleteAttachment(targetId: string, storedFileName: string): Promise<void> {
    const attachmentsDir = this.resolveAttachmentsDir(targetId);
    const safeName = sanitizeFileName(storedFileName);
    await fs.rm(path.join(attachmentsDir, safeName), { force: true });
  }

  async migrateLegacyState(legacyJson: string): Promise<AppState> {
    const legacy = JSON.parse(legacyJson) as {
      projects?: LegacyProject[];
      activeProjectId?: string;
      activeSessionId?: string;
      activeThreadId?: string;
      settings?: AppSettings;
    };

    const projects = legacy.projects ?? [];
    const workspaceIndex: AppState['workspaceIndex'] = [];

    for (const project of projects) {
      const workspace = this.workspaceFromLegacyProject(project);
      workspaceIndex.push({ id: workspace.id, name: workspace.name, updatedAt: workspace.updatedAt });
      await this.atomicWrite(this.workspaceJsonPath(workspace.id), JSON.stringify(workspace, null, 2));
    }

    const appState: AppState = {
      workspaceIndex,
      activeWorkspaceId: legacy.activeProjectId ?? workspaceIndex[0]?.id ?? null,
      activeSessionId: legacy.activeSessionId ?? legacy.activeThreadId ?? null,
      settings: migrateSettings(legacy.settings)
    };

    await this.atomicWrite(this.appStatePath, JSON.stringify(appState, null, 2));
    return appState;
  }

  async flush(): Promise<void> {
    const writes = Array.from(this.pendingWrites.values());
    this.pendingWrites.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    await Promise.all(writes.map((entry) => this.atomicWrite(entry.filePath, entry.data)));
  }
}
