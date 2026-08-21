import { browser } from 'wxt/browser';
import { countEpisodes, fetchDrama, getDramaId, getEpisodeId } from '@/utils/kisskh';

const BADGE_ID = 'kisskh-ext-badge';
const VIDEO_KEY = 'kisskh-video';

interface StoredVideo {
  url: string;
  ep: string;
  title: string;
  updatedAt: number;
}

function renderBadge(lines: string[]) {
  let badge = document.getElementById(BADGE_ID);
  if (!badge) {
    badge = document.createElement('div');
    badge.id = BADGE_ID;
    badge.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'right:16px',
      'z-index:2147483647',
      'max-width:520px',
      'padding:8px 12px',
      'border-radius:8px',
      'background:rgba(17,17,17,.92)',
      'color:#fff',
      'font:13px/1.4 system-ui,sans-serif',
      'white-space:pre-line',
      'word-break:break-all',
      'box-shadow:0 2px 10px rgba(0,0,0,.4)',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(badge);
  }
  badge.textContent = lines.join('\n');
}

function removeBadge() {
  document.getElementById(BADGE_ID)?.remove();
}

async function handleVideoUrl(url: string) {
  const ep = getEpisodeId(location.href);
  await browser.storage.local.set({
    [VIDEO_KEY]: { url, ep, title: document.title, updatedAt: Date.now() },
  });
  console.log('[kisskh] video url:', url);
  refreshBadge();
}

/** A subtitle track the page hook saw; the background owns the list. */
async function handleSubtitleUrl(url: string, label?: string) {
  const ep = getEpisodeId(location.href);
  try {
    await browser.runtime.sendMessage({ type: 'kisskh-sub', url, ep, label });
  } catch {
    // Background asleep or extension reloaded.
  }
  console.log('[kisskh] subtitle url:', url);
  refreshBadge();
}

/**
 * Tells the background which episode the tab is on, so captures land under the
 * right one and the previous episode's urls are dropped.
 */
async function setScope(href: string): Promise<void> {
  try {
    await browser.runtime.sendMessage({ type: 'kisskh-scope', ep: getEpisodeId(href) });
  } catch {
    // Background asleep or extension reloaded.
  }
}

/** One captured url as the background hands it over. */
interface MediaEntry {
  url: string;
  ep: string | null;
  kind?: 'video' | 'sub';
}

/** Asks the background for the media it saw this tab download, all episodes. */
async function observedMedia(): Promise<MediaEntry[]> {
  try {
    const media = await browser.runtime.sendMessage({ type: 'kisskh-media' });
    if (!Array.isArray(media)) return [];
    return (media as MediaEntry[]).filter(
      (entry) => entry && typeof entry.url === 'string',
    );
  } catch {
    // Background asleep or extension reloaded; the badge still has the hook.
    return [];
  }
}

/** What the badge last drew, so we only refetch the API when it changes. */
let lastSignature: string | null = null;

async function refreshBadge() {
  const id = getDramaId(location.href);
  if (!id) {
    lastSignature = null;
    removeBadge();
    return;
  }

  const { [VIDEO_KEY]: stored } = await browser.storage.local.get(VIDEO_KEY);
  const hooked =
    stored && (stored as StoredVideo).ep === getEpisodeId(location.href)
      ? (stored as StoredVideo).url
      : null;
  // The background accumulates the whole season; the badge is about the page
  // you are on, so it only shows this episode and counts the rest.
  const ep = getEpisodeId(location.href);
  const captured = await observedMedia();
  const here = captured
    .filter((entry) => entry.ep === ep && entry.kind !== 'sub')
    .map((entry) => entry.url);
  const subsHere = captured.filter(
    (entry) => entry.ep === ep && entry.kind === 'sub',
  ).length;
  const videos = [...new Set([hooked, ...here.reverse()].filter((u): u is string => !!u))];

  const signature = `${id}|${ep}|${captured.length}|${subsHere}|${videos.join(' ')}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  const lines: string[] = [];
  try {
    const drama = await fetchDrama(location.origin, id);
    const { total, listed } = countEpisodes(drama);
    const suffix = listed && listed !== total ? ` (${listed} listed)` : '';
    lines.push(`${drama.title} - ${total} episodes${suffix}`);
  } catch {
    // Fall back to whatever we know without the API.
    lines.push('kisskh');
  }
  lines.push(
    videos.length
      ? `Video: ${videos[0]}`
      : 'No video detected yet - start playback.',
  );
  if (subsHere) lines.push(`${subsHere} subtitle${subsHere > 1 ? 's' : ''} captured`);
  if (captured.length > videos.length + subsHere) {
    lines.push(`${captured.length} captured in total - see the popup`);
  }
  renderBadge(lines);
}

async function run() {
  const id = getDramaId(location.href);
  if (!id) {
    removeBadge();
    return;
  }
  // The page hook is a separate main-world content script (hook.content.ts):
  // the manifest injects it, so it is not subject to any CSP and it beats the
  // site's own bundle to window.fetch.
  await setScope(location.href);
  await refreshBadge();
}

export default defineContentScript({
  matches: [
    '*://kisskh.co/*',
    '*://*.kisskh.co/*',
    '*://kisskh.me/*',
    '*://*.kisskh.me/*',
  ],
  runAt: 'document_idle',
  main(ctx) {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data as {
        source?: string;
        type?: string;
        url?: string;
        label?: string;
      };
      if (data?.source !== 'kisskh-ext' || !data.url) return;
      if (data.type === 'video') void handleVideoUrl(data.url);
      else if (data.type === 'subtitle') void handleSubtitleUrl(data.url, data.label);
    });

    // The popup runs on the extension origin; this page does not, and it
    // already carries the session, so it fetches the drama on the popup's
    // behalf. Errors are reported rather than swallowed.
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if ((message as { type?: string })?.type !== 'kisskh-drama') return;
      const dramaId = getDramaId(location.href);
      if (!dramaId) {
        sendResponse({ error: 'no drama id in the page url' });
        return true;
      }
      fetchDrama(location.origin, dramaId)
        .then((drama) => sendResponse({ drama }))
        .catch((err) =>
          sendResponse({ error: err instanceof Error ? err.message : String(err) }),
        );
      return true;
    });

    void run();
    // kisskh is a SPA: the id changes without a full page load. Chrome fires
    // this from the Navigation API before the navigation commits, so
    // location.href still points at the old episode -- scope off the event's
    // url, which is what beats the new player request to the background.
    ctx.addEventListener(window, 'wxt:locationchange', (event) => {
      void setScope(event.newUrl.href).then(run);
    });
    // webRequest captures land after the page settles, and content scripts
    // cannot subscribe to session storage, so poll for them.
    ctx.setInterval(() => void refreshBadge(), 2000);
  },
});