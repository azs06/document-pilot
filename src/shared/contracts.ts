export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type RunStatus =
  | 'drafting_plan'
  | 'awaiting_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export type StepStatus = 'pending' | 'running' | 'completed' | 'blocked';

export type RiskLevel = 'safe' | 'approval_required' | 'destructive';

export type PermissionArea = 'files' | 'sandbox' | 'web' | 'desktop' | 'plugins' | 'connectors';

export type GrantDuration = 'once' | 'task' | 'workspace';

export type ArtifactKind =
  | 'report'
  | 'document'
  | 'research'
  | 'preview'
  | 'spreadsheet'
  | 'presentation'
  | 'note';

export type OutputBlockType = 'markdown' | 'text' | 'status' | 'warning';

export interface AttachmentRecord {
  id: string;
  originalFileName: string;
  storedFileName: string;
  mimeType: string;
  sizeBytes: number;
  addedAt: number;
  summary?: string;
}

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  toolFamily: string;
  risk: RiskLevel;
  status: StepStatus;
  requiresApproval: boolean;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  summary: string;
  area: PermissionArea;
  targets: string[];
  reason: string;
  reversible: boolean;
  duration: GrantDuration;
  risk: RiskLevel;
  status: 'pending' | 'approved' | 'denied';
}

export interface PermissionGrant {
  id: string;
  area: PermissionArea;
  target: string;
  duration: Exclude<GrantDuration, 'once'>;
  grantedAt: number;
  note?: string;
}

export interface OutputBlock {
  id: string;
  type: OutputBlockType;
  title?: string;
  content: string;
}

export interface ArtifactRecord {
  id: string;
  title: string;
  kind: ArtifactKind;
  summary: string;
  fileName?: string;
  previewContent?: string;
  createdAt: number;
}

export interface TaskRun {
  id: string;
  status: RunStatus;
  model: string;
  latencyMs: number;
  summary: string;
  plan: PlanStep[];
  approvals: ApprovalRequest[];
  outputBlocks: OutputBlock[];
  artifacts: ArtifactRecord[];
  createdAt: number;
  startedAt: number;
  completedAt?: number;
  warning?: string;
}

export interface TaskRecord {
  id: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  runs: TaskRun[];
}

export interface SessionRecord {
  id: string;
  title: string;
  tasks: TaskRecord[];
  attachments: AttachmentRecord[];
  lastUpdated: number;
}

export interface WorkspaceMetadata {
  id: string;
  name: string;
  sessions: SessionRecord[];
  permissionGrants: PermissionGrant[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceIndexEntry {
  id: string;
  name: string;
  updatedAt: number;
}

export interface KeyboardShortcuts {
  sendMessage: string;
  newSession: string;
}

export interface AppSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
  shortcuts: KeyboardShortcuts;
}

export interface AppState {
  workspaceIndex: WorkspaceIndexEntry[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  settings: AppSettings;
}

export interface RunAttachmentContext {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  summary?: string;
}

export interface StartRunRequest {
  prompt: string;
  workspaceName: string;
  sessionTitle: string;
  recentTaskPrompts: string[];
  attachments: RunAttachmentContext[];
  grants: PermissionGrant[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface StartRunResponse {
  run: TaskRun;
}

export interface ResolveApprovalRequest {
  prompt: string;
  workspaceName: string;
  sessionTitle: string;
  recentTaskPrompts: string[];
  attachments: RunAttachmentContext[];
  grants: PermissionGrant[];
  run: TaskRun;
  approvalId: string;
  decision: 'approve' | 'deny';
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ResolveApprovalResponse {
  run: TaskRun;
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

export interface SaveAppStateRequest {
  state: AppState;
}

export interface LoadWorkspaceRequest {
  workspaceId: string;
}

export interface LoadWorkspaceResponse {
  workspace: WorkspaceMetadata | null;
}

export interface SaveWorkspaceRequest {
  workspace: WorkspaceMetadata;
}

export interface DeleteWorkspaceRequest {
  workspaceId: string;
}

export interface CopyAttachmentRequest {
  targetId: string;
  attachmentId: string;
  originalFileName: string;
  mimeType: string;
  fileData: ArrayBuffer;
}

export interface CopyAttachmentResponse {
  attachment: AttachmentRecord;
}

export interface ReadAttachmentRequest {
  targetId: string;
  storedFileName: string;
}

export interface ReadAttachmentResponse {
  fileData: ArrayBuffer;
  originalFileName: string;
  mimeType: string;
}

export interface DeleteAttachmentRequest {
  targetId: string;
  attachmentId: string;
  storedFileName: string;
}

export interface MigrateStateRequest {
  legacyState: string;
}

export interface MigrateStateResponse {
  success: boolean;
  appState: AppState;
}
