// GitHub swaps pages in place, so clicking a "Files changed" link never makes a
// page load the background script can redirect. Turn those clicks into real
// navigations. Modified clicks already open a real load in a new tab or window.
const FILES = /^\/[^/]+\/[^/]+\/pull\/\d+\/(?:files|changes)\/?$/;

let enabled = true;
browser.storage.local.get('enabled').then((s) => (enabled = s.enabled !== false));
browser.storage.onChanged.addListener((c) => {
  if (c.enabled) enabled = c.enabled.newValue !== false;
});

addEventListener(
  'click',
  (e) => {
    if (!enabled || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href]');
    if (!a || a.origin !== location.origin || !FILES.test(a.pathname)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    location.assign(a.href);
  },
  true,
);
