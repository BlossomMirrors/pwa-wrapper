const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const WIDEVINE_DIR = path.join(os.homedir(), '.local/share/blossomos-webapps/widevine');
const CDM_PATH = path.join(WIDEVINE_DIR, 'libwidevinecdm.so');
const MANIFEST_PATH = path.join(WIDEVINE_DIR, 'manifest.json');
const HASH_CACHE_PATH = path.join(WIDEVINE_DIR, 'upstream-hash.txt');
const LAST_CHECK_PATH = path.join(WIDEVINE_DIR, 'last-check.txt');
const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const METADATA_URL =
  'https://raw.githubusercontent.com/mozilla-firefox/firefox/refs/heads/main/toolkit/content/gmp-sources/widevinecdm.json';

function getCachedPath() {
  return fs.existsSync(CDM_PATH) ? CDM_PATH : null;
}

function getCachedVersion() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')).version;
  } catch {
    return null;
  }
}

function getCachedHash() {
  try {
    return fs.readFileSync(HASH_CACHE_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

function shouldCheck() {
  try {
    const last = parseInt(fs.readFileSync(LAST_CHECK_PATH, 'utf8'), 10);
    return Date.now() - last > CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

function markChecked() {
  fs.writeFileSync(LAST_CHECK_PATH, Date.now().toString());
}

async function fetchMetadata() {
  const res = await fetch(METADATA_URL);
  if (!res.ok) throw new Error('Failed to fetch Widevine metadata');
  return res.json();
}

function streamDownload(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    function get(targetUrl) {
      https.get(targetUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const out = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total) onProgress(received / total);
        });
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    }
    get(url);
  });
}

async function downloadAndExtract(onProgress) {
  const meta = await fetchMetadata();
  const platform = meta.vendors['gmp-widevinecdm'].platforms['Linux_x86_64-gcc3'];
  const sourceUrl = platform.mirrorUrls[0];
  const expectedHash = platform.hashValue;

  fs.mkdirSync(WIDEVINE_DIR, { recursive: true });
  const tmpCrx = path.join(os.tmpdir(), 'widevine-' + Date.now() + '.crx');
  const tmpExtract = path.join(os.tmpdir(), 'widevine-extract-' + Date.now());

  try {
    await streamDownload(sourceUrl, tmpCrx, onProgress);

    const hash = crypto.createHash('sha512').update(fs.readFileSync(tmpCrx)).digest('hex');
    if (hash !== expectedHash) throw new Error('Widevine CDM hash mismatch');

    fs.mkdirSync(tmpExtract, { recursive: true });
    // CRX files have a header before the ZIP data; unzip handles it with a warning (exit 1).
    // -o forces overwrite to avoid interactive prompts when re-extracting.
    const r1 = spawnSync('unzip', [
      '-q', '-o', tmpCrx,
      '_platform_specific/linux_x64/libwidevinecdm.so',
      'manifest.json',
      '-d', tmpExtract,
    ], { stdio: 'ignore' });
    if (r1.status !== null && r1.status > 1) {
      const r2 = spawnSync('unzip', ['-q', '-o', tmpCrx, '-d', tmpExtract], { stdio: 'ignore' });
      if (r2.status !== null && r2.status > 1) {
        throw new Error('unzip failed with exit code ' + r2.status);
      }
    }

    const cdmSrc = path.join(tmpExtract, '_platform_specific/linux_x64/libwidevinecdm.so');
    const manifestSrc = path.join(tmpExtract, 'manifest.json');

    if (!fs.existsSync(cdmSrc)) throw new Error('libwidevinecdm.so not found in archive');

    fs.copyFileSync(cdmSrc, CDM_PATH);
    fs.chmodSync(CDM_PATH, 0o755);
    if (fs.existsSync(manifestSrc)) fs.copyFileSync(manifestSrc, MANIFEST_PATH);
    fs.writeFileSync(HASH_CACHE_PATH, expectedHash);
  } finally {
    try { fs.unlinkSync(tmpCrx); } catch {}
    try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch {}
  }
}

async function checkForUpdate() {
  try {
    const meta = await fetchMetadata();
    const platform = meta.vendors['gmp-widevinecdm'].platforms['Linux_x86_64-gcc3'];
    return platform.hashValue !== getCachedHash();
  } catch {
    return false;
  }
}

module.exports = {
  getCachedPath,
  getCachedVersion,
  shouldCheck,
  markChecked,
  downloadAndExtract,
  checkForUpdate,
};
