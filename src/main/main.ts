import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  CopilotAuthStatusRequest,
  CopyAttachmentRequest,
  DeleteAttachmentRequest,
  DeleteWorkspaceRequest,
  LoadWorkspaceRequest,
  SaveAppStateRequest,
  MigrateStateRequest,
  ReadAttachmentRequest,
  ResolveApprovalRequest,
  SaveWorkspaceRequest,
  StartRunRequest
} from '../shared/contracts.js';
import { CopilotRuntime } from './copilotChat.js';
import { ProjectStorage } from './projectStorage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ICON_PATH = path.join(__dirname, '../../build/icon.png');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const runtime = new CopilotRuntime();
const storage = new ProjectStorage();

function createWindow(): BrowserWindow {
  const iconExists = fs.existsSync(APP_ICON_PATH) && fs.statSync(APP_ICON_PATH).size > 0;
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 720,
    ...(iconExists ? { icon: APP_ICON_PATH } : {}),
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

ipcMain.handle('start-run', async (_event, payload: StartRunRequest) => runtime.startRun(payload));
ipcMain.handle('resolve-approval', async (_event, payload: ResolveApprovalRequest) =>
  runtime.resolveApproval(payload)
);
ipcMain.handle('get-copilot-auth-status', async (_event, payload: CopilotAuthStatusRequest) =>
  runtime.getCopilotAuthStatus(payload)
);

// ── Workspace Storage IPC ─────────────────────────────────────────

ipcMain.handle('load-app-state', async () => storage.loadAppState());

ipcMain.handle('save-app-state', (_event, payload: SaveAppStateRequest) => {
  storage.saveAppState(payload.state);
});

ipcMain.handle('load-workspace', async (_event, payload: LoadWorkspaceRequest) => ({
  workspace: await storage.loadWorkspace(payload.workspaceId)
}));

ipcMain.handle('save-workspace', (_event, payload: SaveWorkspaceRequest) => {
  storage.saveWorkspace(payload.workspace);
});

ipcMain.handle('delete-workspace', async (_event, payload: DeleteWorkspaceRequest) => {
  await storage.deleteWorkspace(payload.workspaceId);
});

ipcMain.handle('copy-attachment', async (_event, payload: CopyAttachmentRequest) => ({
  attachment: await storage.copyAttachment(
    payload.targetId,
    payload.attachmentId,
    payload.originalFileName,
    payload.mimeType,
    Buffer.from(payload.fileData)
  )
}));

ipcMain.handle('read-attachment', async (_event, payload: ReadAttachmentRequest) => {
  const result = await storage.readAttachment(payload.targetId, payload.storedFileName);
  return {
    fileData: result.fileData.buffer,
    originalFileName: result.originalFileName,
    mimeType: result.mimeType
  };
});

ipcMain.handle('delete-attachment', async (_event, payload: DeleteAttachmentRequest) => {
  await storage.deleteAttachment(payload.targetId, payload.storedFileName);
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
  try {
    const iconExists = fs.existsSync(APP_ICON_PATH) && fs.statSync(APP_ICON_PATH).size > 0;
    console.log(`[main] App icon path: ${APP_ICON_PATH} (exists: ${iconExists})`);
    if (iconExists && process.platform === 'darwin') {
      app.dock?.setIcon(APP_ICON_PATH);
    }
  } catch (err) {
    console.warn('[main] Failed to set dock icon:', err);
  }

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
  await runtime.stop();
});
