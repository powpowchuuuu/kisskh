import { defineConfig } from 'wxt';

const KISSKH_HOSTS = [
  '*://kisskh.co/*',
  '*://*.kisskh.co/*',
  '*://kisskh.me/*',
  '*://*.kisskh.me/*',
];

// See https://wxt.dev/api/config.html
/**
 * primeicons ships eot/svg/ttf/woff alongside woff2 for browsers this
 * extension cannot run on. Vite emits every one it sees referenced, so the
 * legacy sources are dropped before it looks.
 */
const woff2Only = {
  name: 'woff2-only',
  // Must run before vite:css resolves the url()s into emitted assets.
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.includes('.css') || !code.includes('@font-face')) return null;
    const out = code.replace(/src:\s*([^;]+);/g, (whole, list: string) => {
      if (list.includes('.woff2')) {
        const woff2 = list.split(',').find((part) => part.includes('.woff2'));
        return woff2 ? `src:${woff2};` : whole;
      }
      // primeicons opens with a lone eot src for IE, which carries no woff2
      // to fall back to and so survives the rule above.
      return list.includes('.eot') ? '' : whole;
    });
    return out === code ? null : { code: out, map: null };
  },
};

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [woff2Only] }),
  // Not the default ".output": Finder hides dot-directories, which makes the
  // build impossible to pick in Chrome's "Load unpacked" dialog.
  outDir: 'dist',
  manifest: {
    name: 'KissKH Helper',
    description: 'Shows the episode count of the KissKH drama you are viewing and grabs the video URL.',
    // KISSKH_HOSTS lets the popup call the DramaList API for the active tab's
    // domain; webRequest can only observe what host_permissions covers, and the
    // stream itself is served by a third-party CDN we cannot name in advance.
    host_permissions: [...KISSKH_HOSTS, '<all_urls>'],
    permissions: ['storage', 'webRequest', 'downloads'],
    action: { default_title: 'KissKH Helper' },
  },
});
