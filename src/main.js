const { app, BrowserWindow, ipcMain, shell, WebContentsView } = require('electron');
const minimist = require('minimist');
const os = require('os');
const path = require('path');

const args = minimist(process.argv.slice(2), {
  boolean: ['widevine', 'tray'],
  string: ['url', 'name', 'color', 'css', 'js', 'appid', 'useragent', 'icon', 'url-filter'],
  default: { widevine: false, tray: false },
});

const appid = args.appid || 'default';

const urlFilter = args['url-filter'] ? new RegExp(args['url-filter']) : null;

app.setName(appid);
app.setPath('userData', path.join(os.homedir(), '.local/share/blossomos-webapps', appid));

const widevine = require('./widevine');

if (args.widevine) {
  const cdmPath = widevine.getCachedPath();
  if (cdmPath) {
    const version = widevine.getCachedVersion();
    app.commandLine.appendSwitch('widevine-cdm-path', cdmPath);
    if (version) app.commandLine.appendSwitch('widevine-cdm-version', version);
  }
}

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

const TITLEBAR_HEIGHT = 36;
const CORNER_CSS =
  'html{clip-path:inset(0 0 0 0 round 0 0 20px 20px)!important;}' +
  'html,body{background-color:transparent!important;}';
let mainWin = null;
let contentView = null;
let cornerCssKey = null;

app.whenReady().then(async () => {
  if (args.widevine && !widevine.getCachedPath()) {
    await runWidevineInstaller();
    return;
  }
  createMainWindow();
  if (args.widevine && widevine.shouldCheck()) {
    widevine.checkForUpdate()
      .then(async (needsUpdate) => { widevine.markChecked(); if (needsUpdate) await widevine.downloadAndExtract(); })
      .catch(() => {});
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

async function runWidevineInstaller() {
  const win = new BrowserWindow({
    width: 400, height: 160, resizable: false, center: true, frame: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL('data:text/html,' + encodeURIComponent(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;display:flex;align-items:center;' +
    'justify-content:center;height:100vh;font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;' +
    'background:#18181f;color:#ededf0;text-align:center;}</style></head><body><div>' +
    '<p id="msg">Installing Widevine CDM...</p>' +
    '<p id="sub" style="font-size:12px;color:#91919e;margin-top:8px;">Downloading from Mozilla</p>' +
    '</div></body></html>'
  ));
  try {
    await widevine.downloadAndExtract((p) => {
      if (p && !win.isDestroyed())
        win.webContents.executeJavaScript(
          'document.getElementById("sub").textContent="' + Math.round(p*100) + '% downloaded..."'
        ).catch(() => {});
    });
    app.relaunch(); app.quit();
  } catch (err) {
    if (!win.isDestroyed())
      win.webContents.executeJavaScript(
        'document.getElementById("msg").textContent="Widevine download failed";' +
        'document.getElementById("sub").textContent=' + JSON.stringify(String(err.message || err))
      ).catch(() => {});
  }
}

function createMainWindow() {
  const { setupSession } = require('./session');
  const inject = require('./inject');
  const router = require('./router');

  const ses = setupSession(appid, args.useragent);

  const SCROLLBAR_CSS =
    '::-webkit-scrollbar{width:8px;height:8px}' +
    '::-webkit-scrollbar-track{background:transparent}' +
    '::-webkit-scrollbar-thumb{background:rgba(128,128,128,0.5);border-radius:4px;' +
    'border:2px solid transparent;background-clip:content-box}' +
    '::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,0.7);border-radius:4px;' +
    'border:2px solid transparent;background-clip:content-box}' +
    '::-webkit-scrollbar-corner{background:transparent}';

  mainWin = new BrowserWindow({
    width: 1280, height: 800, minWidth: 400, minHeight: 300,
    frame: false,
    transparent: true,
    show: false,
    icon: args.icon || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload-titlebar.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  });

  mainWin.loadFile(path.join(__dirname, 'titlebar.html'));

  mainWin.webContents.on('did-finish-load', () => {
    mainWin.setContentSize(1280, 800);
    if (!mainWin.isVisible()) mainWin.show();
    updateContentBounds();
    mainWin.webContents.send('titlebar-init', {
      name: args.name || '', color: args.color || null, icon: args.icon || null,
    });
  });

  contentView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-content.js'),
      session: ses,
      nodeIntegration: false, contextIsolation: false, sandbox: false,
    },
  });

  mainWin.contentView.addChildView(contentView);
  updateContentBounds();

  mainWin.on('resize', updateContentBounds);
  mainWin.on('resized', updateContentBounds);
  mainWin.on('maximize', () => {
    mainWin.setBackgroundColor('#18181f');
    updateContentBounds();
    mainWin.webContents.send('window-maximized', true);
    if (cornerCssKey !== null) {
      contentView.webContents.removeInsertedCSS(cornerCssKey).catch(() => {});
      cornerCssKey = null;
    }
  });
  mainWin.on('unmaximize', () => {
    mainWin.setBackgroundColor('#00000000');
    updateContentBounds();
    mainWin.webContents.send('window-maximized', false);
    contentView.webContents.insertCSS(CORNER_CSS).then(k => { cornerCssKey = k; }).catch(() => {});
  });

  function sendNavState() {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('nav-state', {
        canGoBack:    contentView.webContents.canGoBack(),
        canGoForward: contentView.webContents.canGoForward(),
      });
    }
  }

  contentView.webContents.on('did-navigate', sendNavState);
  contentView.webContents.on('did-navigate-in-page', sendNavState);

  function currentBase() {
    return contentView.webContents.getURL() || args.url;
  }

  contentView.webContents.on('will-navigate', (event, url) => {
    const result = router.handle(url, urlFilter, currentBase());
    if (result !== 'internal') event.preventDefault();
  });

  contentView.webContents.setWindowOpenHandler(({ url }) => {
    const decision = router.route(url, urlFilter, currentBase());
    if (decision.type === 'internal') setImmediate(() => contentView.webContents.loadURL(url));
    else if (decision.type === 'webapp') router.launchExec(decision.exec);
    else shell.openExternal(url);
    return { action: 'deny' };
  });

  contentView.webContents.on('did-finish-load', async () => {
    sendNavState();
    contentView.webContents.insertCSS(SCROLLBAR_CSS).catch(() => {});
    cornerCssKey = null;
    if (!mainWin.isMaximized()) {
      contentView.webContents.insertCSS(CORNER_CSS).then(k => { cornerCssKey = k; }).catch(() => {});
    }
    try { await inject.injectCSS(contentView.webContents, args.css); } catch {}
    try { await inject.injectJS(contentView.webContents, args.js); } catch {}
  });

  contentView.webContents.loadURL(args.url || 'about:blank');

  ipcMain.on('nav-action', (event, action) => {
    if (action === 'back')    contentView.webContents.goBack();
    if (action === 'forward') contentView.webContents.goForward();
  });

  ipcMain.on('window-control', (event, action) => {
    if (!mainWin) return;
    if (action === 'minimize') mainWin.minimize();
    else if (action === 'maximize') { if (mainWin.isMaximized()) mainWin.unmaximize(); else mainWin.maximize(); }
    else if (action === 'close') { if (args.tray) mainWin.hide(); else mainWin.close(); }
  });

  ipcMain.on('theme-color', (event, color) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('theme-color', color);
  });

  if (args.tray) {
    const { createTray } = require('./tray');
    createTray(args.icon || null, mainWin);
    mainWin.on('close', (event) => { if (!app.isQuitting) { event.preventDefault(); mainWin.hide(); } });
  }

  app.on('before-quit', () => { app.isQuitting = true; });
}

function updateContentBounds() {
  if (!mainWin || !contentView) return;
  const [w, h] = mainWin.getContentSize();
  contentView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width: w, height: Math.max(0, h - TITLEBAR_HEIGHT) });
}
