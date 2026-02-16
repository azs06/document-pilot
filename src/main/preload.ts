import { contextBridge, ipcRenderer } from 'electron';
import type {
  ChatRequest,
  ChatResponse,
  CopilotAuthStatusRequest,
  CopilotAuthStatusResponse,
  AppState,
  SaveAppStateRequest,
  LoadProjectRequest,
  LoadProjectResponse,
  SaveProjectRequest,
  CopyDocumentRequest,
  CopyDocumentResponse,
  ReadDocumentRequest,
  ReadDocumentResponse,
  DeleteDocumentRequest,
  DeleteProjectRequest,
  MigrateStateRequest,
  MigrateStateResponse
} from '../shared/contracts.js';

const api = {
  chat: (payload: ChatRequest): Promise<ChatResponse> =>
    ipcRenderer.invoke('chat', payload),
  getCopilotAuthStatus: (payload: CopilotAuthStatusRequest): Promise<CopilotAuthStatusResponse> =>
    ipcRenderer.invoke('get-copilot-auth-status', payload),

  // Project storage
  loadAppState: (): Promise<AppState | null> =>
    ipcRenderer.invoke('load-app-state'),
  saveAppState: (payload: SaveAppStateRequest): Promise<void> =>
    ipcRenderer.invoke('save-app-state', payload),
  loadProject: (payload: LoadProjectRequest): Promise<LoadProjectResponse> =>
    ipcRenderer.invoke('load-project', payload),
  saveProject: (payload: SaveProjectRequest): Promise<void> =>
    ipcRenderer.invoke('save-project', payload),
  deleteProject: (payload: DeleteProjectRequest): Promise<void> =>
    ipcRenderer.invoke('delete-project', payload),
  copyDocument: (payload: CopyDocumentRequest): Promise<CopyDocumentResponse> =>
    ipcRenderer.invoke('copy-document', payload),
  readDocument: (payload: ReadDocumentRequest): Promise<ReadDocumentResponse> =>
    ipcRenderer.invoke('read-document', payload),
  deleteDocument: (payload: DeleteDocumentRequest): Promise<void> =>
    ipcRenderer.invoke('delete-document', payload),
  migrateLegacyState: (payload: MigrateStateRequest): Promise<MigrateStateResponse> =>
    ipcRenderer.invoke('migrate-legacy-state', payload)
};

contextBridge.exposeInMainWorld('documentPilot', api);
