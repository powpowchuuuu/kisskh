import { browser } from 'wxt/browser';

/**
 * Watches what the browser actually downloads instead of guessing the site's
 * API. Immune to injection timing, iframes, CSP and the `kkey` signature, and
 * it survives the API being reshaped.
 */
const MEDIA = /\.(m3u8|mpd|mp4)(\?|$)/i;
/** Playlist segments: hundreds per episode, and useless on their own. */
const SEGMENT = /\.(m4s|ts)(\?|$)/i;

const KEY = 'kisskh-media';
/** Room for a whole season, master playlist plus variants. */
const PER_TAB_LIMIT = 200;

interface Entry {
  url: string;
  /** Episode this was captured under; null before the tab told us. */
  ep: string | null;
}

interface TabState {
  /** Episode the tab is currently showing. */
  ep: string | null;
  items: Entry[];
}

type Captured = Record<string, TabState>;

/**
 * The service worker is torn down between events, so storage is the source of
 * truth; this memoises it for the current worker's lifetime. Local rather than
 * session so a queued-up season survives closing the browser.
 */
let captured: Promise<Captured> | null = null;
function load(): Promise<Captured> {
  captured ??= browser.storage.local
    .get(KEY)
    .then((stored) => (stored[KEY] as Captured) ?? {})
    .catch(() => ({}));
  return captured;
}

/** Serialises the read-modify-writes; requests arrive faster than storage. */
let queue: Promise<unknown> = Promise.resolve();
function enqueue(work: (data: Captured) => boolean) {
  queue = queue
    .then(async () => {
      const data = await load();
      if (!work(data)) return;
      await browser.storage.local.set({ [KEY]: data });
    })
    .catch(() => {});
  return queue;
}

function stateOf(data: Captured, tabId: number): TabState {
  return (data[String(tabId)] ??= { ep: null, items: [] });
}

/**
 * Everything the tab has captured, in capture order, each keeping the episode
 * it came from. The list accumulates so a whole season can be queued up.
 */
function visible(data: Captured, tabId: number): Entry[] {
  return data[String(tabId)]?.items ?? [];
}

/**
 * Tab ids are handed out again after a restart, so a list left behind by a
 * closed tab would resurface under an unrelated one. Drop anything whose tab
 * is gone.
 */
async function prune(): Promise<void> {
  const tabs = await browser.tabs.query({});
  const live = new Set(tabs.map((tab) => String(tab.id)));
  await enqueue((data) => {
    let dropped = false;
    for (const tabId of Object.keys(data)) {
      if (live.has(tabId)) continue;
      delete data[tabId];
      dropped = true;
    }
    return dropped;
  });
}

export default defineBackground(() => {
  void prune();

  browser.webRequest.onBeforeRequest.addListener(
    ({ tabId, url }): undefined => {
      if (tabId < 0 || SEGMENT.test(url) || !MEDIA.test(url)) return;
      void enqueue((data) => {
        const state = stateOf(data, tabId);
        if (state.items.some((item) => item.url === url)) return false;
        state.items.push({ url, ep: state.ep });
        if (state.items.length > PER_TAB_LIMIT) {
          state.items.splice(0, state.items.length - PER_TAB_LIMIT);
        }
        return true;
      });
    },
    { urls: ['<all_urls>'] },
  );

  // Content scripts cannot read session storage, and the popup should not have
  // to duplicate the episode filtering, so everything goes through here.
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, tabId: fromPopup, url, ep } = (message ?? {}) as {
      type?: string;
      tabId?: number;
      url?: string;
      ep?: string | null;
    };
    const tabId = sender.tab?.id ?? fromPopup;
    if (tabId === undefined) return;

    const answer = () => void load().then((data) => sendResponse(visible(data, tabId)));

    switch (type) {
      case 'kisskh-media':
        answer();
        return true;

      // kisskh is a SPA, so there is no navigation commit to hang this off:
      // the tab tells us which episode it moved to.
      case 'kisskh-scope':
        void enqueue((data) => {
          const state = stateOf(data, tabId);
          const next = ep ?? null;
          if (state.ep === next) return false;
          // Captures made before we knew the episode belong to the one we have
          // just been told about. Everything already tagged keeps its own.
          for (const item of state.items) item.ep ??= next;
          state.ep = next;
          return true;
        }).then(answer);
        return true;

      case 'kisskh-dismiss':
        void enqueue((data) => {
          const state = data[String(tabId)];
          const at = state?.items.findIndex((item) => item.url === url) ?? -1;
          if (!state || at < 0) return false;
          state.items.splice(at, 1);
          return true;
        }).then(answer);
        return true;

      case 'kisskh-clear':
        void enqueue((data) => {
          const state = data[String(tabId)];
          if (!state?.items.length) return false;
          state.items = [];
          return true;
        }).then(answer);
        return true;

      default:
        return;
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void enqueue((data) => {
      if (!(String(tabId) in data)) return false;
      delete data[String(tabId)];
      return true;
    });
  });
});
