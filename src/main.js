// path, fs and child_process are loaded before electron so that the Wayland
// proxy can be started before Chromium opens its own Wayland connection.
const path = require('path');
const fs   = require('fs');
const { spawn } = require('child_process');
const minimist = require('minimist');

const args = minimist(process.argv.slice(2), {
  boolean: ['widevine', 'tray', 'minimized'],
  string: ['url', 'name', 'color', 'css', 'js', 'appid', 'useragent', 'icon', 'url-filter'],
  default: { widevine: false, tray: false, minimized: false },
});

const appid = args.appid || 'default';

// Start the Wayland socket proxy BEFORE require('electron') so that
// Chromium's Wayland connection goes through it from the first connect().
// The proxy intercepts xdg_toplevel.set_app_id and replaces the product name
// ("blossomos-webapps") with the real appid, fixing KWin's Fensterklasse.
if (process.platform === 'linux' && appid !== 'default') {
  const xdgRuntime  = process.env.XDG_RUNTIME_DIR || '/tmp';
  const origDisplay = process.env.WAYLAND_DISPLAY  || 'wayland-0';
  const proxyName   = `wayland-blossomos-${process.pid}`;
  const proxySocket = path.join(xdgRuntime, proxyName);

  // Locate the compiled proxy binary (dev: src/, packaged: resources/)
  const binCandidates = [
    path.join(__dirname, 'wayland-appid-proxy'),
    process.resourcesPath ? path.join(process.resourcesPath, 'wayland-appid-proxy') : '',
  ].filter(Boolean);
  const proxyBin = binCandidates.find(p => fs.existsSync(p));

  if (proxyBin) {
    const child = spawn(proxyBin, [proxyName, origDisplay, appid], {
      stdio: ['ignore', 'ignore', 'inherit'],
      detached: false,
    });
    child.on('error', err => process.stderr.write(`[pwa-wrapper] proxy: ${err}\n`));

    // Synchronous wait: poll until the proxy creates its socket (or 5 s timeout).
    const sab    = new SharedArrayBuffer(4);
    const sabArr = new Int32Array(sab);
    const limit  = Date.now() + 5000;
    while (!fs.existsSync(proxySocket) && Date.now() < limit) {
      Atomics.wait(sabArr, 0, 0, 20);
    }

    if (fs.existsSync(proxySocket)) {
      process.env.WAYLAND_DISPLAY = proxyName;
      process.stderr.write(`[pwa-wrapper] Wayland proxy ready (${proxyName})\n`);
    } else {
      process.stderr.write('[pwa-wrapper] Wayland proxy timed out, appid unchanged\n');
      child.kill();
    }
  } else {
    process.stderr.write('[pwa-wrapper] wayland-appid-proxy not found, appid will not be set\n');
  }
}

const { app, BrowserWindow, components, ipcMain, shell, WebContentsView } = require('electron');
const os = require('os');

const urlFilter = args['url-filter'] ? new RegExp(args['url-filter']) : null;

app.setName(appid);
app.setPath('userData', path.join(os.homedir(), '.local/share/blossomos-webapps', appid));

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

const TITLEBAR_HEIGHT = 36;
// Rounded corners and bottom border gated on .w-corner class; toggled via executeJavaScript
// so there are no async key-tracking races with insertCSS/removeInsertedCSS.
const CORNER_CSS =
  'html.w-corner{overflow:hidden!important;height:100vh!important;' +
  'clip-path:inset(0 0 0 0 round 0 0 19px 19px)!important;' +
  'background-color:rgba(0,0,0,0.001)!important;}' +
  'html.w-corner body{overflow:auto!important;height:100%!important;}' +
  'html.w-corner::after{content:\'\';position:absolute;inset:0;' +
  'border:1px solid var(--w-border,rgba(255,255,255,0.12));border-top:none;' +
  'border-radius:0 0 19px 19px;pointer-events:none;z-index:2147483647;}';
const SCROLLBAR_CSS =
  '::-webkit-scrollbar{width:8px;height:8px}' +
  '::-webkit-scrollbar-track{background:transparent}' +
  '::-webkit-scrollbar-thumb{background:rgba(128,128,128,0.5);border-radius:4px;' +
  'border:2px solid transparent;background-clip:content-box}' +
  '::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,0.7);border-radius:4px;' +
  'border:2px solid transparent;background-clip:content-box}' +
  '::-webkit-scrollbar-corner{background:transparent}';
let mainWin = null;
let contentView = null;
let currentBorderColor = 'rgba(255,255,255,0.12)';

function syncCornerClass() {
  if (!contentView || contentView.webContents.isDestroyed()) return;
  const windowed = !mainWin.isMaximized() && !mainWin.isFullScreen();
  contentView.webContents.executeJavaScript(
    `document.documentElement.classList[${JSON.stringify(windowed ? 'add' : 'remove')}]('w-corner');void 0`
  ).catch(() => {});
}

function updateCornerBorder(color) {
  currentBorderColor = color;
  if (!contentView || contentView.webContents.isDestroyed()) return;
  contentView.webContents.executeJavaScript(
    `document.documentElement.style.setProperty('--w-border',${JSON.stringify(color)});void 0`
  ).catch(() => {});
}

app.whenReady().then(async () => {
  if (args.widevine) await components.whenReady();
  await createMainWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });


async function createMainWindow() {
  const { setupSession } = require('./session');
  const inject = require('./inject');
  const router = require('./router');

  const ses = setupSession(appid, args.useragent);

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
    if (!mainWin.isVisible()) {
      if (args.minimized && args.tray) { /* stay hidden, tray-only */ }
      else if (args.minimized) mainWin.minimize();
      else mainWin.show();
    }
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

  contentView.setBackgroundColor('#00000000');
  mainWin.contentView.addChildView(contentView);
  updateContentBounds();

  mainWin.on('resize', updateContentBounds);
  mainWin.on('resized', updateContentBounds);
  mainWin.on('maximize', () => {
    mainWin.setBackgroundColor('#18181f');
    updateContentBounds();
    mainWin.webContents.send('window-maximized', true);
    syncCornerClass();
  });
  mainWin.on('unmaximize', () => {
    mainWin.setBackgroundColor('#00000000');
    updateContentBounds();
    mainWin.webContents.send('window-maximized', false);
    syncCornerClass();
  });

  function applyFullscreen(isFullscreen) {
    mainWin.webContents.send('fullscreen', isFullscreen);
    mainWin.setBackgroundColor(isFullscreen ? '#000000' : '#00000000');
    syncCornerClass();
    updateContentBounds();
  }
  mainWin.on('enter-full-screen', () => applyFullscreen(true));
  mainWin.on('leave-full-screen', () => applyFullscreen(false));

  // HTML5 fullscreen from inside the web app (e.g. video player fullscreen button).
  contentView.webContents.on('enter-html-full-screen', () => { if (!mainWin.isFullScreen()) mainWin.setFullScreen(true); });
  contentView.webContents.on('leave-html-full-screen',  () => { if (mainWin.isFullScreen())  mainWin.setFullScreen(false); });

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
    await Promise.all([
      contentView.webContents.insertCSS(SCROLLBAR_CSS),
      contentView.webContents.insertCSS(CORNER_CSS),
    ]).catch(() => {});
    // Sync class and border color after CSS is in the renderer.
    syncCornerClass();
    updateCornerBorder(currentBorderColor);
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

  ipcMain.on('border-color', (event, color) => updateCornerBorder(color));

  if (args.tray) {
    const { createTray } = require('./tray');
    const tray = await createTray(args.icon || null, mainWin, args.name || null);
    if (tray) mainWin.on('close', (event) => { if (!app.isQuitting) { event.preventDefault(); mainWin.hide(); } });
  }

  app.on('before-quit', () => { app.isQuitting = true; });
}

function updateContentBounds() {
  if (!mainWin || !contentView) return;
  const [w, h] = mainWin.getContentSize();
  const fs = mainWin.isFullScreen();
  const tbH = fs ? 0 : TITLEBAR_HEIGHT;
  contentView.setBounds({
    x: 0,
    y: tbH,
    width: w,
    height: Math.max(0, h - tbH),
  });
}
