// Sends GitHub "Files changed" page loads to the local diff server, if it is up.
// When it is down, or the toolbar button has turned this off, GitHub loads as usual.
const SERVER = 'http://127.0.0.1:7717';
const FILES = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes)\/?(?:[?#]|$)/;

let enabled = true;
function setEnabled(on) {
  enabled = on;
  browser.browserAction.setBadgeText({ text: on ? '' : 'off' });
  browser.browserAction.setTitle({ title: `diff: ${on ? 'on' : 'off'}` });
}
browser.storage.local.get('enabled').then((s) => setEnabled(s.enabled !== false));
browser.browserAction.onClicked.addListener(() => {
  setEnabled(!enabled);
  browser.storage.local.set({ enabled });
});

async function serverUp() {
  try {
    return (await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

browser.webRequest.onBeforeRequest.addListener(
  async ({ url }) => {
    const m = enabled && FILES.exec(url);
    if (!m || !(await serverUp())) return {};
    return { redirectUrl: `${SERVER}/${m[1]}/${m[2]}/pull/${m[3]}/files` };
  },
  { urls: ['https://github.com/*/pull/*'], types: ['main_frame'] },
  ['blocking'],
);
