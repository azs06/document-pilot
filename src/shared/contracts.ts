export type ChartType = 'bar' | 'line' | 'pie' | 'doughnut';

export type SortOrder = 'asc' | 'desc' | 'none';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface DatasetSummary {
  headers: string[];
  rowCount: number;
  sampleRows: Array<Record<string, string | number | null>>;
  numericColumns: string[];
}

export interface AnalyzeDatasetRequest {
  prompt: string;
  dataset: DatasetSummary;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface VisualizationPlan {
  chartType: ChartType;
  title: string;
  xField: string;
  yField?: string;
  derivedMetric?: 'goal_difference';
  sort: SortOrder;
  maxPoints: number;
  reason: string;
}

export interface AnalyzeDatasetResponse {
  plan: VisualizationPlan;
  source: 'copilot' | 'fallback';
  model: string;
  latencyMs: number;
  warning?: string;
}

export interface AnalyzePdfRequest {
  prompt: string;
  fileName: string;
  pdfData: ArrayBuffer;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface AnalyzePdfResponse {
  analysis: string;
  source: 'copilot' | 'fallback';
  model: string;
  latencyMs: number;
  pageCount: number;
  extractedChars: number;
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
