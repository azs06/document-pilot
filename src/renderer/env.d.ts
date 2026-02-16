import type {
  AnalyzeDatasetRequest,
  AnalyzeDatasetResponse,
  CopilotAuthStatusRequest,
  CopilotAuthStatusResponse,
  AnalyzePdfRequest,
  AnalyzePdfResponse
} from '../shared/contracts.js';

declare global {
  interface Window {
    documentPilot: {
      analyzeDataset: (payload: AnalyzeDatasetRequest) => Promise<AnalyzeDatasetResponse>;
      analyzePdf: (payload: AnalyzePdfRequest) => Promise<AnalyzePdfResponse>;
      getCopilotAuthStatus: (payload: CopilotAuthStatusRequest) => Promise<CopilotAuthStatusResponse>;
    };
  }
}

export {};
