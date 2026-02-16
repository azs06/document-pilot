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

declare global {
  interface Window {
    documentPilot: {
      chat: (payload: ChatRequest) => Promise<ChatResponse>;
      getCopilotAuthStatus: (payload: CopilotAuthStatusRequest) => Promise<CopilotAuthStatusResponse>;
      loadAppState: () => Promise<AppState | null>;
      saveAppState: (payload: SaveAppStateRequest) => Promise<void>;
      loadProject: (payload: LoadProjectRequest) => Promise<LoadProjectResponse>;
      saveProject: (payload: SaveProjectRequest) => Promise<void>;
      deleteProject: (payload: DeleteProjectRequest) => Promise<void>;
      copyDocument: (payload: CopyDocumentRequest) => Promise<CopyDocumentResponse>;
      readDocument: (payload: ReadDocumentRequest) => Promise<ReadDocumentResponse>;
      deleteDocument: (payload: DeleteDocumentRequest) => Promise<void>;
      migrateLegacyState: (payload: MigrateStateRequest) => Promise<MigrateStateResponse>;
    };
  }
}

export {};
