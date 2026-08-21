import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

const KISSKH_HOSTS = [
  '*://kisskh.co/*',
  '*://*.kisskh.co/*',
  '*://kisskh.me/*',
  '*://*.kisskh.me/*',
];

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
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
