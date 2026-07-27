'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { BrowserWindow } = require('electron');

// Aurorae SVGs are laid out at their native (small) size; render at an
// upscaled factor and let <img> downscale so tiles stay crisp on HiDPI.
const MAX_RASTER_SCALE = 3;
// Requesting a window bigger than the display just clamps harmlessly (seen
// in practice), so ask big; resizing an *existing* offscreen window mid
// session is what crashes the GPU process, which is why scale (below) is
// chosen instead of ever growing the window after creation.
const HARNESS_WIDTH = 1920;
const HARNESS_HEIGHT = 1080;
const SAFE_MARGIN = 60;

const DECORATION_PIECES = ['topleft', 'top', 'topright'];
const BUTTON_TYPES = ['close', 'minimize', 'maximize', 'restore'];
const BUTTON_STATE_IDS = ['active', 'inactive', 'hover', 'pressed', 'deactivated'];
// Per the Aurorae spec, themes only have to provide the 5 canonical button
// states above; combined active/inactive-hover states fall back to the
// plain state when a theme doesn't define them separately.
const BUTTON_STATE_FALLBACKS = {
  hoverInactive: 'hover',
  pressedInactive: 'pressed',
  deactivatedInactive: 'deactivated',
};

// ---------------------------------------------------------------- ini/rc parsing

function camelCase(key) {
  return key.charAt(0).toLowerCase() + key.slice(1);
}

function parseIni(text) {
  const sections = {};
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1];
      if (!sections[current]) sections[current] = {};
      continue;
    }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (kv && current) sections[current][kv[1].trim()] = kv[2].trim();
  }
  return sections;
}

function coerceValue(raw) {
  if (/^-?\d+$/.test(raw)) return Number(raw);
  const rgb = raw.match(/^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/);
  if (rgb) return `rgb(${rgb[1]}, ${rgb[2]}, ${rgb[3]})`;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

function camelCaseSection(section) {
  const out = {};
  for (const [k, v] of Object.entries(section || {})) out[camelCase(k)] = coerceValue(v);
  return out;
}

// ---------------------------------------------------------------- theme detection

function readKwinrcDecorationSection() {
  try {
    const kwinrcPath = path.join(os.homedir(), '.config', 'kwinrc');
    const sections = parseIni(fs.readFileSync(kwinrcPath, 'utf8'));
    return sections['org.kde.kdecoration2'] || null;
  } catch {
    return null;
  }
}

function detectLiveThemeDir() {
  const deco = readKwinrcDecorationSection();
  if (!deco) return null;
  const library = deco.library || '';
  if (!/^org\.kde\.kwin\.aurorae(\.v2)?$/.test(library)) return null;
  const match = (deco.theme || '').match(/^__aurorae__svg__(.+)$/);
  if (!match) return null;
  const name = match[1];
  const candidates = [
    path.join(os.homedir(), '.local', 'share', 'aurorae', 'themes', name),
    path.join('/usr/share/aurorae/themes', name),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, `${name}rc`))) return { dir, name };
  }
  return null;
}

// The Breeze/Aurorae symbolic-icon convention: SVGs reference classes like
// `.ColorScheme-Text` with fill="currentColor", resolved at runtime via a
// <style id="current-color-scheme"> element. Build that stylesheet from the
// user's actual Plasma color scheme so themes relying on it render correctly
// instead of falling back to whatever default browsers give unstyled content
// (this theme's decoration.svg accent fill uses ColorScheme-ViewFocus, for
// instance -- without this it silently renders black instead of the accent).
const COLOR_SCHEME_CLASS_MAP = {
  'ColorScheme-Text': ['Colors:Window', 'ForegroundNormal'],
  'ColorScheme-Background': ['Colors:Window', 'BackgroundNormal'],
  'ColorScheme-Highlight': ['Colors:Selection', 'BackgroundNormal'],
  'ColorScheme-HighlightText': ['Colors:Selection', 'ForegroundNormal'],
  'ColorScheme-PositiveText': ['Colors:Window', 'ForegroundPositive'],
  'ColorScheme-NeutralText': ['Colors:Window', 'ForegroundNeutral'],
  'ColorScheme-NegativeText': ['Colors:Window', 'ForegroundNegative'],
  'ColorScheme-ButtonText': ['Colors:Button', 'ForegroundNormal'],
  'ColorScheme-ButtonBackground': ['Colors:Button', 'BackgroundNormal'],
  'ColorScheme-ButtonHover': ['Colors:Button', 'DecorationHover'],
  'ColorScheme-ButtonFocus': ['Colors:Button', 'DecorationFocus'],
  'ColorScheme-ViewText': ['Colors:View', 'ForegroundNormal'],
  'ColorScheme-ViewBackground': ['Colors:View', 'BackgroundNormal'],
  'ColorScheme-ViewHover': ['Colors:View', 'DecorationHover'],
  'ColorScheme-ViewFocus': ['Colors:View', 'DecorationFocus'],
};

function readColorSchemeCss() {
  try {
    const kdeglobalsPath = path.join(os.homedir(), '.config', 'kdeglobals');
    const sections = parseIni(fs.readFileSync(kdeglobalsPath, 'utf8'));
    const rules = [];
    for (const [cls, [section, key]] of Object.entries(COLOR_SCHEME_CLASS_MAP)) {
      const raw = (sections[section] || {})[key];
      if (!raw) continue;
      rules.push(`.${cls} { color: ${coerceValue(raw)}; }`);
    }
    return rules.join('\n');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- rasterization harness

let harnessWin = null;
let harnessReady = null;

function ensureHarness() {
  if (harnessWin && !harnessWin.isDestroyed()) return harnessReady;
  harnessWin = new BrowserWindow({
    show: false,
    width: HARNESS_WIDTH,
    height: HARNESS_HEIGHT,
    // Decoration/button art relies on real alpha transparency (shadow
    // blur fading to nothing, button hit-areas at ~0 opacity) -- without
    // this the window's own opaque white background gets baked into every
    // capture, turning "transparent" shadow into a solid white block.
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: false, nodeIntegration: false, sandbox: false,
      // A normal hidden window's capturePage() reliably hangs after the
      // first couple of calls on this Wayland/GPU setup (reproducible:
      // repeated capturePage() on the same webContents eventually stops
      // getting paint callbacks). Offscreen rendering doesn't depend on
      // the window compositor at all and doesn't exhibit this.
      offscreen: true,
    },
  });
  // The very first capturePage() on a freshly created offscreen webContents
  // can return a stale/incomplete frame (reproducible: identical rasterize
  // logic is correct on every call except the first one in a session) --
  // a throwaway warm-up capture avoids that landing on real output.
  harnessReady = harnessWin.loadFile(path.join(__dirname, 'harness.html'))
    .then(() => harnessWin.webContents.capturePage());
  return harnessReady;
}

function closeHarness() {
  if (harnessWin && !harnessWin.isDestroyed()) harnessWin.destroy();
  harnessWin = null;
  harnessReady = null;
}

// Sample a representative solid color from near the bottom-center of a tile
// (reliably inside the theme's actual chrome color rather than the
// shadow-blur margin above it). Used for flat-color fills instead of tiling
// the raster image itself, which leaves visible seams for non-uniform art.
function sampleColor(fullImage, rect) {
  const size = fullImage.getSize();
  const sx = Math.min(size.width - 1, Math.max(0, Math.round(rect.x + rect.width / 2)));
  const sy = Math.min(size.height - 1, Math.max(0, Math.round(rect.y + rect.height - 2)));
  const buf = fullImage.crop({ x: sx, y: sy, width: 1, height: 1 }).toBitmap();
  if (buf.length < 4) return null;
  const [b, g, r, a] = buf;
  if (a === 0) return null;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

async function measureIds(win, ids) {
  const bboxes = {};
  for (const id of ids) {
    bboxes[id] = await win.webContents.executeJavaScript(`window.__measure(${JSON.stringify(id)})`);
  }
  return bboxes;
}

// Themes lay state/variant groups out at absolute coordinates that can run
// well past the SVG's nominal declared canvas size (this theme's "inactive"
// decoration pieces sit far to the right of "active", for instance). Load
// once, probe every id we're about to need at scale 1 to learn the true
// extent, then just re-scale (no second content reload -- reloading twice
// before the first-ever capture on a fresh offscreen webContents was
// observed to capture a stale/intermediate frame) to the largest scale that
// still fits the fixed-size harness before the single capture -- one
// capturePage() per file rather than one per element, which is both faster
// and avoids capturePage(rect) hangs seen for some regions.
async function rasterizeIds(win, svgPath, colorSchemeCss, ids) {
  const svgText = fs.readFileSync(svgPath, 'utf8');
  await win.webContents.executeJavaScript(`window.__setColorScheme(${JSON.stringify(colorSchemeCss)})`);
  await win.webContents.executeJavaScript(`window.__loadSvg(${JSON.stringify(svgText)}, 1)`);

  const probe = await measureIds(win, ids);
  let maxExtentX = 1;
  let maxExtentY = 1;
  for (const bbox of Object.values(probe)) {
    if (!bbox) continue;
    maxExtentX = Math.max(maxExtentX, bbox.x + bbox.width);
    maxExtentY = Math.max(maxExtentY, bbox.y + bbox.height);
  }
  const [winW, winH] = win.getContentSize();
  const scale = Math.max(1, Math.min(
    MAX_RASTER_SCALE,
    Math.floor((winW - SAFE_MARGIN) / maxExtentX),
    Math.floor((winH - SAFE_MARGIN) / maxExtentY),
  ));

  let bboxes = probe;
  if (scale !== 1) {
    await win.webContents.executeJavaScript(`window.__setScale(${scale})`);
    bboxes = await measureIds(win, ids);
  }

  // capturePage() can occasionally return a stale/blank frame right after a
  // content swap (seen on this Wayland/GPU setup, not just on the very first
  // capture of a session) -- a throwaway capture first reliably settles it
  // before the one we actually keep.
  await win.webContents.capturePage();
  const fullImage = await win.webContents.capturePage();
  const tiles = {};
  for (const id of ids) {
    const bbox = bboxes[id];
    if (!bbox || bbox.width <= 0 || bbox.height <= 0) continue;
    const rect = {
      x: Math.floor(bbox.x),
      y: Math.floor(bbox.y),
      width: Math.ceil(bbox.width),
      height: Math.ceil(bbox.height),
    };
    const cropped = fullImage.crop(rect);
    tiles[id] = {
      dataUrl: cropped.toDataURL(),
      width: rect.width / scale,
      height: rect.height / scale,
      color: sampleColor(fullImage, rect),
    };
  }
  return tiles;
}

// ---------------------------------------------------------------- theme render

async function renderAuroraeThemeFromDir(dir, name) {
  const rcPath = path.join(dir, `${name}rc`);
  if (!fs.existsSync(rcPath)) return null;

  const rcSections = parseIni(fs.readFileSync(rcPath, 'utf8'));
  const general = camelCaseSection(rcSections.General);
  const layout = camelCaseSection(rcSections.Layout);

  if (!general.leftButtons || !general.rightButtons) {
    const kwinDeco = readKwinrcDecorationSection() || {};
    if (!general.leftButtons) general.leftButtons = kwinDeco.ButtonsOnLeft || 'MS';
    if (!general.rightButtons) general.rightButtons = kwinDeco.ButtonsOnRight || 'HIAX';
  }

  let meta = {};
  const metadataPath = path.join(dir, 'metadata.desktop');
  if (fs.existsSync(metadataPath)) {
    const metaSections = parseIni(fs.readFileSync(metadataPath, 'utf8'));
    meta = camelCaseSection(metaSections['Desktop Entry']);
  }

  const colorSchemeCss = readColorSchemeCss();
  await ensureHarness();
  const win = harnessWin;

  let frame = null;
  const decorationSvg = path.join(dir, 'decoration.svg');
  if (fs.existsSync(decorationSvg)) {
    const decorationIds = [];
    for (const state of ['active', 'inactive']) {
      const prefix = state === 'active' ? 'decoration' : 'decoration-inactive';
      const maxPrefix = `${prefix}-maximized`;
      for (const piece of DECORATION_PIECES) {
        decorationIds.push(`${prefix}-${piece}`, `${maxPrefix}-${piece}`);
      }
    }
    const tiles = await rasterizeIds(win, decorationSvg, colorSchemeCss, decorationIds);
    frame = {};
    for (const state of ['active', 'inactive']) {
      const prefix = state === 'active' ? 'decoration' : 'decoration-inactive';
      const maxPrefix = `${prefix}-maximized`;
      const pieces = {};
      const maxPieces = {};
      for (const piece of DECORATION_PIECES) {
        if (tiles[`${prefix}-${piece}`]) pieces[piece] = tiles[`${prefix}-${piece}`];
        if (tiles[`${maxPrefix}-${piece}`]) maxPieces[piece] = tiles[`${maxPrefix}-${piece}`];
      }
      frame[state] = pieces;
      frame[`${state}Maximized`] = maxPieces;
    }
  }

  const buttons = {};
  for (const type of BUTTON_TYPES) {
    const svgPath = path.join(dir, `${type}.svg`);
    if (!fs.existsSync(svgPath)) continue;
    const stateIds = BUTTON_STATE_IDS.map(s => `${s}-center`);
    const tiles = await rasterizeIds(win, svgPath, colorSchemeCss, stateIds);
    const states = {};
    let width = 0;
    let height = 0;
    for (const stateId of BUTTON_STATE_IDS) {
      const tile = tiles[`${stateId}-center`];
      if (tile) {
        states[stateId] = tile;
        width = Math.max(width, tile.width);
        height = Math.max(height, tile.height);
      }
    }
    if (!states.active) continue;
    for (const [combined, base] of Object.entries(BUTTON_STATE_FALLBACKS)) {
      states[combined] = states[base] || states.active;
    }
    buttons[type] = { width, height, states };
  }

  if (!frame || (!Object.keys(frame.active).length && !Object.keys(frame.inactive).length)) return null;

  return { name, meta, general, layout, frame, buttons };
}

module.exports = { renderAuroraeThemeFromDir, detectLiveThemeDir, closeHarness };
