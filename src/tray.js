const { app, Menu, nativeImage, Tray } = require('electron');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(new URL(url).pathname) || '.png';
    const dest = path.join(os.tmpdir(), `blossomos-tray-icon${ext}`);
    const file = fs.createWriteStream(dest);
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return downloadToTemp(res.headers.location).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function makeDefaultIcon() {
  const size = 22;
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x - cx, y - cy) <= r) {
        const i = (y * size + x) * 4;
        buf[i] = 0xed; buf[i + 1] = 0xed; buf[i + 2] = 0xf0; buf[i + 3] = 0xff;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

async function createTray(iconPath, win, name) {
  let resolvedPath = iconPath;
  if (iconPath && /^https?:\/\//.test(iconPath)) {
    try { resolvedPath = await downloadToTemp(iconPath); } catch { resolvedPath = null; }
  }
  // Prefer a path string — nativeImage.createFromBitmap can return a broken object on some Wayland builds.
  let trayArg = resolvedPath;
  if (!trayArg) {
    try {
      const img = makeDefaultIcon();
      if (img && !img.isEmpty()) trayArg = img;
    } catch {}
  }
  if (!trayArg) return null;

  let tray;
  try { tray = new Tray(trayArg); } catch { return null; }
  tray.setToolTip(name || win.title || 'blossomos-webapps');

  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);

  tray.on('activate', () => { win.show(); win.focus(); });
  tray.on('click', () => { win.show(); win.focus(); });

  return tray;
}

module.exports = { createTray };
