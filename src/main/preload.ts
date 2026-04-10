import { contextBridge, ipcRenderer } from 'electron';
import type {
  CopilotAuthStatusRequest,
  CopilotAuthStatusResponse,
  AppState,
  SaveAppStateRequest,
  LoadWorkspaceRequest,
  LoadWorkspaceResponse,
  SaveWorkspaceRequest,
  CopyAttachmentRequest,
  CopyAttachmentResponse,
  ReadAttachmentRequest,
  ReadAttachmentResponse,
  DeleteAttachmentRequest,
  DeleteWorkspaceRequest,
  MigrateStateRequest,
  MigrateStateResponse,
  ResolveApprovalRequest,
  ResolveApprovalResponse,
  StartRunRequest,
  StartRunResponse
} from '../shared/contracts.js';

const api = {
  startRun: (payload: StartRunRequest): Promise<StartRunResponse> =>
    ipcRenderer.invoke('start-run', payload),
  resolveApproval: (payload: ResolveApprovalRequest): Promise<ResolveApprovalResponse> =>
    ipcRenderer.invoke('resolve-approval', payload),
  getCopilotAuthStatus: (payload: CopilotAuthStatusRequest): Promise<CopilotAuthStatusResponse> =>
    ipcRenderer.invoke('get-copilot-auth-status', payload),

  // Workspace storage
  loadAppState: (): Promise<AppState | null> =>
    ipcRenderer.invoke('load-app-state'),
  saveAppState: (payload: SaveAppStateRequest): Promise<void> =>
    ipcRenderer.invoke('save-app-state', payload),
  loadWorkspace: (payload: LoadWorkspaceRequest): Promise<LoadWorkspaceResponse> =>
    ipcRenderer.invoke('load-workspace', payload),
  saveWorkspace: (payload: SaveWorkspaceRequest): Promise<void> =>
    ipcRenderer.invoke('save-workspace', payload),
  deleteWorkspace: (payload: DeleteWorkspaceRequest): Promise<void> =>
    ipcRenderer.invoke('delete-workspace', payload),
  copyAttachment: (payload: CopyAttachmentRequest): Promise<CopyAttachmentResponse> =>
    ipcRenderer.invoke('copy-attachment', payload),
  readAttachment: (payload: ReadAttachmentRequest): Promise<ReadAttachmentResponse> =>
    ipcRenderer.invoke('read-attachment', payload),
  deleteAttachment: (payload: DeleteAttachmentRequest): Promise<void> =>
    ipcRenderer.invoke('delete-attachment', payload),
  migrateLegacyState: (payload: MigrateStateRequest): Promise<MigrateStateResponse> =>
    ipcRenderer.invoke('migrate-legacy-state', payload)
};

contextBridge.exposeInMainWorld('documentPilot', api);
