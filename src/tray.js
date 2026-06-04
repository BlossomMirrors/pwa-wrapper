const { app, Menu, nativeImage, Tray } = require('electron');

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

function createTray(iconPath, win) {
  let icon = iconPath ? nativeImage.createFromPath(iconPath) : null;
  if (!icon || icon.isEmpty()) icon = makeDefaultIcon();

  const tray = new Tray(icon);
  tray.setToolTip(win.title || 'blossomos-webapps');

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
