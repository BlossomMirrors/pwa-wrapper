const { exec } = require('child_process');
const { shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APPS_DIR = path.join(os.homedir(), '.local/share/applications');

function parseDesktopFile(content) {
  const entry = {};
  let inDesktopEntry = false;
  for (const line of content.split('\n')) {
    if (line.startsWith('[Desktop Entry]')) { inDesktopEntry = true; continue; }
    if (line.startsWith('[') && inDesktopEntry) break;
    if (!inDesktopEntry) continue;
    const eq = line.indexOf('=');
    if (eq > 0) entry[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return entry;
}

function extractUrlArg(exec) {
  const m = exec.match(/--url[= ](['"]?)([^\s'"]+)\1/);
  return m ? m[2] : null;
}

function getOrigin(urlStr) {
  try { return new URL(urlStr).origin; } catch { return null; }
}

function findMatchingWebApp(targetUrl) {
  const targetOrigin = getOrigin(targetUrl);
  if (!targetOrigin) return null;

  let files;
  try { files = fs.readdirSync(APPS_DIR).filter(f => f.endsWith('.desktop')); }
  catch { return null; }

  for (const file of files) {
    let content;
    try { content = fs.readFileSync(path.join(APPS_DIR, file), 'utf8'); }
    catch { continue; }
    const entry = parseDesktopFile(content);
    if (!entry.Exec || !entry.Exec.includes('blossomos-webapps')) continue;
    const appUrl = extractUrlArg(entry.Exec);
    if (appUrl && getOrigin(appUrl) === targetOrigin) return entry.Exec;
  }
  return null;
}

function launchExec(execStr) {
  const cleaned = execStr.replace(/%[uUfFdDnNikvm%]/g, '').trim();
  const child = exec(cleaned, { detached: true });
  child.unref();
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

function route(targetUrl, urlFilter, baseUrl) {
  if (urlFilter) {
    if (urlFilter.test(targetUrl)) return { type: 'internal' };
  } else if (baseUrl && sameOrigin(targetUrl, baseUrl)) {
    return { type: 'internal' };
  }

  const execStr = findMatchingWebApp(targetUrl);
  if (execStr) return { type: 'webapp', exec: execStr };

  return { type: 'external' };
}

function handle(targetUrl, urlFilter, baseUrl) {
  const decision = route(targetUrl, urlFilter, baseUrl);
  if (decision.type === 'webapp') launchExec(decision.exec);
  else if (decision.type === 'external') shell.openExternal(targetUrl);
  return decision.type;
}

module.exports = { route, handle, launchExec };
