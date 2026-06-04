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
