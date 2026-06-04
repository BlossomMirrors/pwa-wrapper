const { net } = require('electron');

async function fetchText(url) {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error('Failed to fetch ' + url + ': HTTP ' + res.status);
  return res.text();
}

async function injectCSS(webContents, cssUrl) {
  if (!cssUrl) return;
  const css = await fetchText(cssUrl);
  await webContents.executeJavaScript(
    '(()=>{ const el=document.createElement("style"); el.textContent=' +
    JSON.stringify(css) +
    '; document.head.appendChild(el); })()'
  );
}

async function injectJS(webContents, jsUrl) {
  if (!jsUrl) return;
  const js = await fetchText(jsUrl);
  await webContents.executeJavaScript(
    '(()=>{ const el=document.createElement("script"); el.textContent=' +
    JSON.stringify(js) +
    '; (document.head||document.documentElement).appendChild(el); })()'
  );
}

module.exports = { injectCSS, injectJS };
