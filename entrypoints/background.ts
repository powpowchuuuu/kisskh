import { browser } from 'wxt/browser';
import { DEFAULT_LANGS, LANGS_KEY, matchesLanguages } from '@/utils/kisskh';

/**
 * Watches what the browser actually downloads instead of guessing the site's
 * API. Immune to injection timing, iframes, CSP and the `kkey` signature, and
 * it survives the API being reshaped.
 */
const MEDIA = /\.(m3u8|mpd|mp4)(\?|$)/i;
/** Subtitle files: small, downloadable directly. */
const SUB_MEDIA = /\.(srt|vtt|ass|ssa|txt|txt1)(\?|$)/i;
/** Playlist segments: hundreds per episode, and useless on their own. */
const SEGMENT = /\.(m4s|ts)(\?|$)/i;

const KEY = 'kisskh-media';
/** Room for a whole season, master playlist plus variants. */
const PER_TAB_LIMIT = 200;

interface Entry {
  url: string;
  /** Episode this was captured under; null before the tab told us. */
  ep: string | null;
  /** 'video' (m3u8/mpd/mp4) or 'sub' (srt/vtt/...). */
  kind: 'video' | 'sub';
  /** Language of a subtitle track, when the page told us. */
  label?: string;
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
function visible(data: Captured, tabId: number, langs: readonly string[]): Entry[] {
  const items = data[String(tabId)]?.items ?? [];
  // Filtered on read rather than on capture, so changing the chosen languages
  // applies to everything already seen instead of only to what comes next.
  return items.filter(
    (item) => item.kind !== 'sub' || matchesLanguages(langs, item.label, item.url),
  );
}

/** The chosen subtitle languages, cached for this worker's lifetime. */
let langs: Promise<string[]> | null = null;
function loadLangs(): Promise<string[]> {
  langs ??= browser.storage.local
    .get(LANGS_KEY)
    .then((stored) => {
      const chosen = stored[LANGS_KEY];
      return Array.isArray(chosen) ? (chosen as string[]) : [...DEFAULT_LANGS];
    })
    .catch(() => [...DEFAULT_LANGS]);
  return langs;
}

// The popup writes the selection straight to storage; drop the cache so the
// next read reflects it.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && LANGS_KEY in changes) langs = null;
});

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

/**
 * Network calls made on the popup's behalf. A cross-origin fetch from an
 * extension page is not reliably exempt from CORS -- a Range header alone
 * triggers a preflight the cdn answers without any allow headers -- while the
 * service worker's fetches are covered by host_permissions.
 */
async function fetchFor(url: string, wantText: boolean) {
  const res = await fetch(url, wantText ? {} : { headers: { range: 'bytes=0-0' } });
  return {
    ok: res.ok || res.status === 206,
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    // After redirects: this is what exposes one file listed under two paths.
    finalUrl: res.url || url,
    text: wantText ? (await res.text()).slice(0, 400_000) : undefined,
  };
}

/**
 * POSTs the listing. Reports the transport failure and the server's own
 * refusal differently: a wrong token is a 401 the user can act on, an
 * unreachable NAS is not.
 */
async function push(url: string, token: string | undefined, payload: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token?.trim()) headers['x-token'] = token.trim();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return {
      ok: res.ok,
      status: res.status,
      // A short excerpt only: the point is to show why it was refused.
      body: res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: err instanceof Error ? err.message : 'request failed',
    };
  }
}

export default defineBackground(() => {
  void prune();

  browser.webRequest.onBeforeRequest.addListener(
    ({ tabId, url }): undefined => {
      if (tabId < 0 || SEGMENT.test(url)) return;
      let kind: 'video' | 'sub' | null = null;
      if (MEDIA.test(url)) kind = 'video';
      else if (SUB_MEDIA.test(url)) kind = 'sub';
      if (!kind) return;
      void enqueue((data) => {
        const state = stateOf(data, tabId);
        if (state.items.some((item) => item.url === url)) return false;
        state.items.push({ url, ep: state.ep, kind });
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
    const { type, tabId: fromPopup, url, ep, label } = (message ?? {}) as {
      type?: string;
      tabId?: number;
      url?: string;
      ep?: string | null;
      label?: string;
    };
    // Pushes the listing to the user's own server. Runs here for the same
    // reason every other request does: a cross-origin fetch from the popup is
    // not reliably exempt from CORS, and this one crosses to an arbitrary host.
    if (type === 'kisskh-push') {
      const { url: target, token, payload } = (message ?? {}) as {
        url?: string;
        token?: string;
        payload?: unknown;
      };
      if (!target) return;
      void push(target, token, payload).then(sendResponse);
      return true;
    }

    // Not tied to a tab: answer before the tab id is required.
    if (type === 'kisskh-fetch') {
      if (!url) return;
      const wantText = (message as { text?: boolean })?.text === true;
      void fetchFor(url, wantText)
        .then(sendResponse)
        .catch(() => sendResponse(null));
      return true;
    }

    const tabId = sender.tab?.id ?? fromPopup;
    if (tabId === undefined) return;

    const answer = () =>
      void Promise.all([load(), loadLangs()]).then(([data, chosen]) =>
        sendResponse(visible(data, tabId, chosen)),
      );

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

      // The page hook saw a subtitle track the webRequest watcher may not
      // (e.g. it was listed in the source JSON but never fetched as a file).
      case 'kisskh-sub': {
        if (!url) return;
        void enqueue((data) => {
          const state = stateOf(data, tabId);
          // Already there from webRequest, but without a language: fill it in.
          const known = state.items.find((item) => item.url === url);
          if (known) {
            if (!label || known.label === label) return false;
            known.label = label;
            return true;
          }
          state.items.push({ url, ep: ep ?? null, kind: 'sub', label });
          if (state.items.length > PER_TAB_LIMIT) {
            state.items.splice(0, state.items.length - PER_TAB_LIMIT);
          }
          return true;
        }).then(answer);
        return true;
      }

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
