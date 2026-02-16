import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalyzeDatasetRequest, AnalyzePdfRequest, CopilotAuthStatusRequest } from '../shared/contracts.js';
import { CopilotPlanner } from './copilotPlanner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const planner = new CopilotPlanner();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const devServerUrl = process.env.DOCUMENT_PILOT_DEV_SERVER_URL;

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '../../dist-renderer/index.html'));
  }

  win.webContents.on('did-finish-load', async () => {
    try {
      const hasBridge = await win.webContents.executeJavaScript('Boolean(window.documentPilot)', true);
      if (!hasBridge) {
        console.error('[document-pilot] preload bridge missing (window.documentPilot unavailable)');
      }
    } catch (error) {
      console.error('[document-pilot] preload verification failed:', error);
    }
  });

  return win;
}

ipcMain.handle('analyze-dataset', async (_event, payload: AnalyzeDatasetRequest) => planner.planVisualization(payload));
ipcMain.handle('analyze-pdf', async (_event, payload: AnalyzePdfRequest) => planner.analyzePdf(payload));
ipcMain.handle('get-copilot-auth-status', async (_event, payload: CopilotAuthStatusRequest) =>
  planner.getCopilotAuthStatus(payload)
);

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  await planner.stop();
});
