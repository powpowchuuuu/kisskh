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
  // Not the default ".output": Finder hides dot-directories, which makes the
  // build impossible to pick in Chrome's "Load unpacked" dialog.
  outDir: 'dist',
  manifest: {
    name: 'KissKH Helper',
    description: 'Shows the episode count of the KissKH drama you are viewing.',
    // Lets the popup call the DramaList API for the active tab's domain.
    host_permissions: KISSKH_HOSTS,
    action: { default_title: 'KissKH Helper' },
  },
});
