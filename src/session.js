const { session } = require('electron');

const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// Chromium sends sec-ch-ua based on the actual browser build, ignoring setUserAgent().
// These values must be overridden at the network layer so requests look like Chrome 148.
const SEC_CH_UA = '"Not/A)Brand";v="99", "Google Chrome";v="148", "Chromium";v="148"';

function setupSession(appid, useragent) {
  const partition = 'persist:' + appid;
  const ses = session.fromPartition(partition);
  ses.setUserAgent(useragent || DEFAULT_UA);

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const h = Object.assign({}, details.requestHeaders);
    h['sec-ch-ua']                  = SEC_CH_UA;
    h['sec-ch-ua-mobile']           = '?0';
    h['sec-ch-ua-platform']         = '"Linux"';
    h['sec-ch-ua-platform-version'] = '"6.1.0"';
    callback({ requestHeaders: h });
  });

  return ses;
}

module.exports = { setupSession };
