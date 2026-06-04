const { session } = require('electron');
const os = require('os');

const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// Chromium sends sec-ch-ua based on the actual browser build, ignoring setUserAgent().
// These values must be overridden at the network layer so requests look like Chrome 148.
const SEC_CH_UA = '"Not/A)Brand";v="99", "Google Chrome";v="148", "Chromium";v="148"';

// Linux kernel version without distro suffix (e.g. "7.0.9" from "7.0.9-205.fc44.x86_64").
const PLATFORM_VERSION = '"' + os.release().split('-')[0] + '"';

function setupSession(appid, useragent) {
  const partition = 'persist:' + appid;
  const ses = session.fromPartition(partition);
  ses.setUserAgent(useragent || DEFAULT_UA);

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const h = Object.assign({}, details.requestHeaders);
    h['sec-ch-ua']                  = SEC_CH_UA;
    h['sec-ch-ua-mobile']           = '?0';
    h['sec-ch-ua-platform']         = '"Linux"';
    h['sec-ch-ua-platform-version'] = PLATFORM_VERSION;
    callback({ requestHeaders: h });
  });

  // Grant all permission requests so EME/Widevine and media APIs are not silently denied.
  ses.setPermissionRequestHandler((webContents, permission, callback) => callback(true));
  ses.setPermissionCheckHandler(() => true);

  return ses;
}

module.exports = { setupSession };
