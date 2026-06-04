const { app, BrowserWindow, components, ipcMain, shell, WebContentsView } = require('electron');
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

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

const TITLEBAR_HEIGHT = 36;
const BORDER_WIDTH = 1;
// Inner clip radius = outer window radius − border width so corners are concentric.
const CORNER_CSS =
  'html{clip-path:inset(0 0 0 0 round 0 0 19px 19px)!important;}' +
  'html,body{background-color:transparent!important;}';
let mainWin = null;
let contentView = null;
let cornerCssKey = null;

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

  contentView.setBackgroundColor('#00000000');
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
    if (!mainWin.isFullScreen())
      contentView.webContents.insertCSS(CORNER_CSS).then(k => { cornerCssKey = k; }).catch(() => {});
  });

  function applyFullscreen(isFullscreen) {
    mainWin.webContents.send('fullscreen', isFullscreen);
    mainWin.setBackgroundColor(isFullscreen ? '#000000' : '#00000000');
    if (isFullscreen && cornerCssKey !== null) {
      contentView.webContents.removeInsertedCSS(cornerCssKey).catch(() => {});
      cornerCssKey = null;
    }
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
    contentView.webContents.insertCSS(SCROLLBAR_CSS).catch(() => {});
    cornerCssKey = null;
    if (!mainWin.isMaximized() && !mainWin.isFullScreen()) {
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
  const bw = (fs || mainWin.isMaximized()) ? 0 : BORDER_WIDTH;
  contentView.setBounds({
    x: bw,
    y: tbH,
    width: Math.max(0, w - 2 * bw),
    height: Math.max(0, h - tbH - bw),
  });
}
