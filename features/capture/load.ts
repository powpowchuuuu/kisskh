/** Assembling one view of the tab: the drama, and the files captured for it. */
import { browser } from 'wxt/browser';
import { fetchDrama, type KisskhDrama } from '@/features/kisskh/api';
import { NAMES_KEY, VIDEO_KEY } from '@/features/kisskh/storage';
import { getDramaId, getEpisodeId, isKisskhUrl } from '@/features/kisskh/url';
import {
  isSubtitle,
  kindOf,
  labelFromUrl,
  resourceKey,
} from '@/features/capture/kind';
import { requestMedia } from '@/features/capture/remote';
import type { Item, State } from '@/features/capture/types';

/**
 * The popup runs on the extension origin, the page does not. Ask the page
 * first: it is same-origin with the api and already carries the session.
 * Falling back to a direct fetch keeps this working when no content script
 * has been injected into the tab yet.
 */
export async function loadDrama(
  tabId: number | undefined,
  origin: string,
  id: string,
): Promise<{ drama: KisskhDrama | null; dramaError?: string }> {
  if (tabId !== undefined) {
    try {
      const reply = (await browser.tabs.sendMessage(tabId, { type: 'kisskh-drama' })) as
        | { drama?: KisskhDrama; error?: string }
        | undefined;
      if (reply?.drama) return { drama: reply.drama };
      if (reply?.error) return { drama: null, dramaError: `page: ${reply.error}` };
    } catch {
      // No content script in this tab; a direct fetch may still work.
    }
  }
  try {
    return { drama: await fetchDrama(origin, id) };
  } catch (err) {
    return {
      drama: null,
      dramaError: `popup: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function load(): Promise<State> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url;

  if (!url || !isKisskhUrl(url)) {
    return { status: 'idle', message: 'Open a KissKH page to see its episodes.' };
  }

  const id = getDramaId(url);
  if (!id) {
    return { status: 'idle', message: 'This KissKH page has no drama id in its URL.' };
  }

  const origin = new URL(url).origin;
  const ep = getEpisodeId(url);

  const { [VIDEO_KEY]: stored } = await browser.storage.local.get(VIDEO_KEY);
  const s = stored as { url?: string; ep?: string | null } | undefined;
  // `ep` is null on pages without one, so compare rather than test for truth.
  const hooked = s && s.ep === ep && typeof s.url === 'string' ? s.url : null;

  const entries = await requestMedia(tab?.id);

  // Two sources describe the same stream in different words: the page hook
  // reports the url the api *advertises*, the background reports what the
  // browser actually *downloaded* -- often the same file behind a redirect or
  // a signing token, which is why it showed up as two cards.
  //
  // When the background already has a video for this episode, that one is the
  // authority and the hook's url is dropped. If it has none, the hook's url is
  // all we have, so it is kept.
  const downloadedHere = entries.some((e) => e.kind !== 'sub' && e.ep === ep);
  if (hooked && !downloadedHere && !entries.some((e) => e.url === hooked)) {
    entries.push({ url: hooked, ep });
  }

  const { drama, dramaError } = await loadDrama(tab?.id, origin, id);

  const numberOf = new Map(
    (drama?.episodes ?? []).map((e) => [String(e.id), e.number] as const),
  );

  const { [NAMES_KEY]: savedNames } = await browser.storage.local.get(NAMES_KEY);
  const names = (savedNames as Record<string, string> | undefined) ?? {};

  // Without the drama api there is still a usable name on the tab itself.
  const fallbackTitle = (tab?.title ?? '').replace(/\s*[-|]\s*kisskh.*$/i, '').trim();

  const seen = new Set<string>();
  const items: Item[] = [];
  for (const entry of entries) {
    const key = resourceKey(entry.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const episode = entry.ep === null ? null : (numberOf.get(entry.ep) ?? null);
    const kind = kindOf(entry.url, entry.kind);
    const isSub = kind === 'SRT' || kind === 'VTT' || kind === 'SUB';
    // Fall back to .srt so a subtitle whose url carries no extension still
    // saves as something a player will open.
    const ext =
      (entry.url.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1] ?? (isSub ? 'srt' : '')).toLowerCase();
    const label = isSub ? (entry.label ?? labelFromUrl(entry.url)) : undefined;
    const stem = drama
      ? `${drama.title}${episode === null ? '' : ` Episode ${episode}`}`
      : fallbackTitle;
    // Subtitles are only distinguishable by language, so it goes in the name.
    const base = isSub
      ? `${stem ? `${stem} ` : ''}${label ?? 'subtitle'}.${ext}`
      : `${stem ? `${stem} ` : ''}kisskh.mp4`;
    items.push({
      url: entry.url,
      ep: entry.ep,
      episode,
      kind,
      label,
      name: names[entry.url] ?? base,
      duration: null,
    });
  }
  // Episode order, so the list reads 1, 2, 3 however you browsed them.
  items.sort((a, b) => (a.episode ?? Infinity) - (b.episode ?? Infinity));

  return { status: 'ready', drama, dramaError, tabId: tab?.id, origin, items };
}
