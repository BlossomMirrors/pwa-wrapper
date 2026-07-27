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

// requestSingleInstanceLock() keys its lock off the userData path set above,
// so this only enforces one instance per appid, not one instance globally.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

app.on('second-instance', () => {
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    if (!mainWin.isVisible()) mainWin.show();
    mainWin.focus();
  }
});

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

let titlebarHeight = 36;
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

app.whenReady().then(async () => {
  if (args.widevine) await components.whenReady();
  await createMainWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });


// BrowserWindow.setBackgroundColor() only accepts hex; titlebar colors are
// produced as rgb()/rgba() (theme accent, custom app color) or already hex.
function toHexColor(color) {
  if (typeof color !== 'string') return null;
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  const m = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return null;
  const toHex = n => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
}

async function resolveAuroraeTheme() {
  const aurorae = require('./aurorae/render');
  try {
    const live = aurorae.detectLiveThemeDir();
    const dir  = live ? live.dir  : path.join(__dirname, 'aurorae', 'fallback-theme');
    const name = live ? live.name : 'ActiveAccentDawn';
    return await aurorae.renderAuroraeThemeFromDir(dir, name);
  } catch (err) {
    process.stderr.write(`[pwa-wrapper] aurorae render failed: ${err}\n`);
    return null;
  }
}

async function createMainWindow() {
  const { setupSession } = require('./session');
  const inject = require('./inject');
  const router = require('./router');

  // Kicked off in parallel with window/webContents setup below so the
  // (comparatively slow) SVG rasterization overlaps normal startup instead
  // of serializing after it; awaited just before it's actually needed.
  const auroraeThemePromise = resolveAuroraeTheme();

  const ses = setupSession(appid, args.useragent);

  mainWin = new BrowserWindow({
    width: 1280, height: 800, minWidth: 400, minHeight: 300,
    frame: false,
    backgroundColor: '#18181f',
    show: false,
    icon: args.icon || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload-titlebar.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  });

  mainWin.loadFile(path.join(__dirname, 'titlebar.html'));

  mainWin.webContents.on('did-finish-load', async () => {
    mainWin.setContentSize(1280, 800);
    if (!mainWin.isVisible()) {
      if (args.minimized && args.tray) { /* stay hidden, tray-only */ }
      else if (args.minimized) mainWin.minimize();
      else mainWin.show();
    }
    updateContentBounds();
    const aurorae = await auroraeThemePromise;
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('titlebar-init', {
        name: args.name || '', color: args.color || null, icon: args.icon || null,
        aurorae,
      });
    }
  });

  mainWin.on('focus', () => mainWin.webContents.send('focus-change', true));
  mainWin.on('blur',  () => mainWin.webContents.send('focus-change', false));

  contentView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-content.js'),
      session: ses,
      nodeIntegration: false, contextIsolation: false, sandbox: false,
    },
  });

  contentView.setBackgroundColor('#18181f');
  mainWin.contentView.addChildView(contentView);
  updateContentBounds();

  mainWin.on('resize', updateContentBounds);
  mainWin.on('resized', updateContentBounds);
  mainWin.on('maximize', () => {
    updateContentBounds();
    mainWin.webContents.send('window-maximized', true);
  });
  mainWin.on('unmaximize', () => {
    updateContentBounds();
    mainWin.webContents.send('window-maximized', false);
  });

  function applyFullscreen(isFullscreen) {
    mainWin.webContents.send('fullscreen', isFullscreen);
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
    await contentView.webContents.insertCSS(SCROLLBAR_CSS).catch(() => {});
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

  ipcMain.on('titlebar-resize', (event, height) => {
    if (typeof height !== 'number' || height <= 0) return;
    titlebarHeight = height;
    updateContentBounds();
  });

  ipcMain.on('titlebar-color', (event, color) => {
    const hex = toHexColor(color);
    if (hex && mainWin && !mainWin.isDestroyed()) mainWin.setBackgroundColor(hex);
  });

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
  const tbH = fs ? 0 : titlebarHeight;
  contentView.setBounds({
    x: 0,
    y: tbH,
    width: w,
    height: Math.max(0, h - tbH),
  });
}
