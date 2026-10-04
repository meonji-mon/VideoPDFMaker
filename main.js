const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { WorkspaceStore } = require('./workspace-store');

const pageURL = pathToFileURL(path.join(__dirname, 'index.html')).href;
let store;

function trustedSender(event) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== pageURL) {
    throw new Error('허용되지 않은 요청입니다.');
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 850, minWidth: 1000, minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true
    }
  });
  // All runtime dependencies are bundled; local media remains available offline.
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
    (_details, callback) => callback({ cancel: true })
  );
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== pageURL) event.preventDefault();
  });
  const allowFullscreen = (contents, permission) => permission === 'fullscreen' && contents?.getURL() === pageURL;
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(allowFullscreen(contents, permission)));
  win.webContents.session.setPermissionCheckHandler((contents, permission) => allowFullscreen(contents, permission));
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  store = new WorkspaceStore();
  const configPath = path.join(app.getPath('userData'), 'workspace.json');
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    trustedSender(event);
    return callback(event, ...args);
  });
  handle('workspace:choose', async event => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '작업할 영상 폴더 선택', properties: ['openDirectory']
    });
    if (result.canceled) return null;
    const workspace = store.selectRoot(result.filePaths[0]);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ root: store.root }), 'utf8');
    return workspace;
  });
  handle('workspace:restore', () => {
    if (!fs.existsSync(configPath)) return null;
    const { root } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return fs.existsSync(root) ? store.selectRoot(root) : null;
  });
  handle('video:open', (_event, id) => store.openVideo(id));
  handle('snapshot:capture', (_event, videoId, image, time) => store.capture(videoId, image, time));
  handle('snapshot:save', (_event, videoId, snapshots) => store.saveSnapshots(videoId, snapshots));
  handle('snapshot:delete', (_event, videoId, id) => store.deleteSnapshot(videoId, id));
  handle('snapshot:reset', (_event, videoId) => store.reset(videoId));
  handle('snapshot:restore', (_event, videoId) => store.restoreSnapshots(videoId));
  handle('snapshot:draw', (_event, videoId, id, image) => store.saveDrawing(videoId, id, image));
  handle('pdf:save', (_event, videoId, data) => store.savePDF(videoId, data));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
