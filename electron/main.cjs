const { app, BrowserWindow, Menu, protocol, net, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'elb', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    title: 'LabMate',
    backgroundColor: '#f9f1df',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      partition: 'elb-preview',
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.loadURL('elb://app/index.html');
}

app.whenReady().then(() => {
  const previewSession = session.fromPartition('elb-preview');
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('elb://app/') });
  });
  previewSession.protocol.handle('elb', request => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    let relativePath;
    try { relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, ''); }
    catch { return new Response('Invalid path', { status: 400 }); }
    const root = path.join(app.getAppPath(), 'dist');
    const filePath = path.resolve(root, relativePath || 'index.html');
    if (!filePath.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'LabMate', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
