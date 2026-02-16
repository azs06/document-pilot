import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ChatRequest,
  CopilotAuthStatusRequest,
  SaveAppStateRequest,
  LoadProjectRequest,
  SaveProjectRequest,
  CopyDocumentRequest,
  ReadDocumentRequest,
  DeleteDocumentRequest,
  DeleteProjectRequest,
  MigrateStateRequest
} from '../shared/contracts.js';
import { CopilotChat } from './copilotChat.js';
import { ProjectStorage } from './projectStorage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const chat = new CopilotChat();
const storage = new ProjectStorage();

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

ipcMain.handle('chat', async (_event, payload: ChatRequest) => chat.chat(payload));
ipcMain.handle('get-copilot-auth-status', async (_event, payload: CopilotAuthStatusRequest) =>
  chat.getCopilotAuthStatus(payload)
);

// ── Project Storage IPC ───────────────────────────────────────────

ipcMain.handle('load-app-state', async () => storage.loadAppState());

ipcMain.handle('save-app-state', (_event, payload: SaveAppStateRequest) => {
  storage.saveAppState(payload.state);
});

ipcMain.handle('load-project', async (_event, payload: LoadProjectRequest) => ({
  project: await storage.loadProject(payload.projectId)
}));

ipcMain.handle('save-project', (_event, payload: SaveProjectRequest) => {
  storage.saveProject(payload.project);
});

ipcMain.handle('delete-project', async (_event, payload: DeleteProjectRequest) => {
  await storage.deleteProject(payload.projectId);
});

ipcMain.handle('copy-document', async (_event, payload: CopyDocumentRequest) => ({
  storedDocument: await storage.copyDocument(
    payload.targetId,
    payload.documentId,
    payload.originalFileName,
    Buffer.from(payload.fileData)
  )
}));

ipcMain.handle('read-document', async (_event, payload: ReadDocumentRequest) => {
  const result = await storage.readDocument(payload.targetId, payload.storedFileName);
  return { fileData: result.fileData.buffer, originalFileName: result.originalFileName, kind: result.kind };
});

ipcMain.handle('delete-document', async (_event, payload: DeleteDocumentRequest) => {
  await storage.deleteDocument(payload.targetId, payload.storedFileName);
});

ipcMain.handle('migrate-legacy-state', async (_event, payload: MigrateStateRequest) => {
  const appState = await storage.migrateLegacyState(payload.legacyState);
  return { success: true, appState };
});

app.on('second-instance', () => {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    if (windows[0].isMinimized()) windows[0].restore();
    windows[0].focus();
  }
});

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
  await storage.flush();
  await chat.stop();
});
