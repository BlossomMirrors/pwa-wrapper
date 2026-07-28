(function() {
  const platformVersion = require('os').release().split('-')[0];
  const brands = [
    { brand: 'Not/A)Brand', version: '99' },
    { brand: 'Google Chrome', version: '148' },
    { brand: 'Chromium', version: '148' },
  ];
  const fullBrands = [
    { brand: 'Not/A)Brand', version: '99.0.0.0' },
    { brand: 'Google Chrome', version: '148.0.0.0' },
    { brand: 'Chromium', version: '148.0.0.0' },
  ];
  const uaData = {
    brands,
    mobile: false,
    platform: 'Linux',
    getHighEntropyValues(hints) {
      return Promise.resolve({
        architecture: 'x86',
        bitness: '64',
        brands,
        fullVersionList: fullBrands,
        mobile: false,
        model: '',
        platform: 'Linux',
        platformVersion,
        uaFullVersion: '148.0.0.0',
        wow64: false,
      });
    },
    toJSON() { return { brands, mobile: false, platform: 'Linux' }; },
  };
  try {
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => uaData,
      configurable: true,
    });
  } catch {}

  // Prevent automation-control detection.
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch {}

  // Real Chrome/Chromium builds expose window.chrome; Electron's build does not,
  // which is a common signal used to flag "unsafe" / automated browsers.
  try {
    if (!window.chrome) {
      window.chrome = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        },
        csi() { return { onloadT: Date.now(), pageT: Date.now(), startE: Date.now(), tran: 15 }; },
        loadTimes() {
          return {
            commitLoadTime: Date.now() / 1000,
            connectionInfo: 'h2',
            finishDocumentLoadTime: Date.now() / 1000,
            finishLoadTime: Date.now() / 1000,
            firstPaintAfterLoadTime: 0,
            firstPaintTime: Date.now() / 1000,
            navigationType: 'Other',
            npnNegotiatedProtocol: 'h2',
            requestTime: Date.now() / 1000,
            startLoadTime: Date.now() / 1000,
            wasAlternateProtocolAvailable: false,
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
          };
        },
      };
    }
  } catch {}

  // navigator.plugins/mimeTypes being empty is a strong headless/embedded-browser
  // signal; real desktop Chrome always reports the built-in PDF viewer entries.
  try {
    const mimeTypeDefs = [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ];
    const pluginDefs = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    ];

    function makeArrayLike(items, tag) {
      const arr = items.slice();
      arr.item = (i) => arr[i] || null;
      arr.namedItem = (name) => arr.find((it) => it.name === name || it.type === name) || null;
      Object.defineProperty(arr, Symbol.toStringTag, { value: tag });
      return arr;
    }

    const mimeTypes = makeArrayLike(
      mimeTypeDefs.map((m) => ({ ...m, enabledPlugin: null })),
      'MimeTypeArray'
    );
    const plugins = makeArrayLike(
      pluginDefs.map((p) => {
        const plugin = makeArrayLike([mimeTypes[0]], 'Plugin');
        return Object.assign(plugin, p);
      }),
      'PluginArray'
    );
    mimeTypes.forEach((m) => { m.enabledPlugin = plugins[0]; });

    Object.defineProperty(Navigator.prototype, 'plugins', { get: () => plugins, configurable: true });
    Object.defineProperty(Navigator.prototype, 'mimeTypes', { get: () => mimeTypes, configurable: true });
  } catch {}

  // Only override the WebGL vendor/renderer when it's a software rasterizer
  // (SwiftShader/llvmpipe); those strings are treated as a strong bot signal
  // by Turnstile and similar challenges. Real hardware strings are left alone.
  try {
    const SOFTWARE_RE = /swiftshader|llvmpipe|software rasterizer/i;
    const spoof = { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics, OpenGL 4.6)' };
    for (const proto of [window.WebGLRenderingContext && window.WebGLRenderingContext.prototype, window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype]) {
      if (!proto) continue;
      const orig = proto.getParameter;
      proto.getParameter = function (param) {
        if (param === 37445 /* UNMASKED_VENDOR_WEBGL */) {
          const real = orig.call(this, param);
          return SOFTWARE_RE.test(real) ? spoof.vendor : real;
        }
        if (param === 37446 /* UNMASKED_RENDERER_WEBGL */) {
          const real = orig.call(this, param);
          return SOFTWARE_RE.test(real) ? spoof.renderer : real;
        }
        return orig.call(this, param);
      };
    }
  } catch {}

  // Keep Notification.permission and permissions.query('notifications') in
  // sync; the session's blanket permission grant otherwise makes them disagree,
  // which is itself a known automation tell.
  try {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (descriptor) => {
      if (descriptor && descriptor.name === 'notifications') {
        return Promise.resolve({
          state: Notification.permission === 'granted' ? 'granted' : Notification.permission === 'denied' ? 'denied' : 'prompt',
          onchange: null,
        });
      }
      return origQuery(descriptor);
    };
  } catch {}
})();

const { ipcRenderer } = require('electron');

// Remove Electron's require/module globals so page scripts cannot reach IPC.
try { delete window.require; } catch {}
try { delete window.module; } catch {}
try { delete window.exports; } catch {}

function getBodyBackground() {
  const root = getComputedStyle(document.documentElement).backgroundColor;
  if (root && root !== 'rgba(0, 0, 0, 0)' && root !== 'transparent') return root;
  if (document.body) {
    const body = getComputedStyle(document.body).backgroundColor;
    if (body && body !== 'rgba(0, 0, 0, 0)' && body !== 'transparent') return body;
  }
  return null;
}

function getThemeMeta() {
  const el = document.querySelector('meta[name="theme-color"]');
  return el ? el.getAttribute('content') : null;
}

function sendColor() {
  const color = getBodyBackground() || getThemeMeta();
  ipcRenderer.send('theme-color', color);
}

function setup() {
  sendColor();
  const observer = new MutationObserver(sendColor);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  if (document.head) {
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['content', 'class', 'style'],
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setup);
} else {
  setup();
}

window.addEventListener('load', sendColor);
