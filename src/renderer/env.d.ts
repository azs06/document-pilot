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

declare global {
  interface Window {
    documentPilot: {
      startRun: (payload: StartRunRequest) => Promise<StartRunResponse>;
      resolveApproval: (payload: ResolveApprovalRequest) => Promise<ResolveApprovalResponse>;
      getCopilotAuthStatus: (payload: CopilotAuthStatusRequest) => Promise<CopilotAuthStatusResponse>;
      loadAppState: () => Promise<AppState | null>;
      saveAppState: (payload: SaveAppStateRequest) => Promise<void>;
      loadWorkspace: (payload: LoadWorkspaceRequest) => Promise<LoadWorkspaceResponse>;
      saveWorkspace: (payload: SaveWorkspaceRequest) => Promise<void>;
      deleteWorkspace: (payload: DeleteWorkspaceRequest) => Promise<void>;
      copyAttachment: (payload: CopyAttachmentRequest) => Promise<CopyAttachmentResponse>;
      readAttachment: (payload: ReadAttachmentRequest) => Promise<ReadAttachmentResponse>;
      deleteAttachment: (payload: DeleteAttachmentRequest) => Promise<void>;
      migrateLegacyState: (payload: MigrateStateRequest) => Promise<MigrateStateResponse>;
    };
  }
}

export {};
