import { contextBridge, ipcRenderer } from 'electron';
import type {
  AnalyzeDatasetRequest,
  AnalyzeDatasetResponse,
  CopilotAuthStatusRequest,
  CopilotAuthStatusResponse,
  AnalyzePdfRequest,
  AnalyzePdfResponse
} from '../shared/contracts.js';

const api = {
  analyzeDataset: (payload: AnalyzeDatasetRequest): Promise<AnalyzeDatasetResponse> =>
    ipcRenderer.invoke('analyze-dataset', payload),
  analyzePdf: (payload: AnalyzePdfRequest): Promise<AnalyzePdfResponse> => ipcRenderer.invoke('analyze-pdf', payload),
  getCopilotAuthStatus: (payload: CopilotAuthStatusRequest): Promise<CopilotAuthStatusResponse> =>
    ipcRenderer.invoke('get-copilot-auth-status', payload)
};

contextBridge.exposeInMainWorld('documentPilot', api);
