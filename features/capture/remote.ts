/**
 * Every network call the popup makes goes through the service worker: a
 * cross-origin fetch from an extension page is not reliably exempt from CORS.
 */
import { browser } from 'wxt/browser';
import type { Entry, Kind } from '@/features/capture/types';

/** One reply from the background's fetch proxy. */
export interface Fetched {
  ok: boolean;
  status: number;
  contentType: string;
  finalUrl: string;
  text?: string;
}

/**
 * Every network call goes through the service worker: a cross-origin fetch
 * from this page is not reliably exempt from CORS, which is what silently
 * defeated the playlist read and the container probe.
 */
export async function remote(url: string, text = false): Promise<Fetched | null> {
  try {
    const reply = await browser.runtime.sendMessage({ type: 'kisskh-fetch', url, text });
    return (reply as Fetched | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Sums the playlist's own #EXTINF values. A master playlist has no segments of
 * its own, so we follow its first variant.
 */
export async function hlsDuration(url: string, depth = 0): Promise<number | null> {
  if (depth > 2) return null;
  const res = await remote(url, true);
  if (!res?.ok || typeof res.text !== 'string') return null;
  const text = res.text;
  const lines = text.split(/\r?\n/);

  if (/^#EXT-X-STREAM-INF/im.test(text)) {
    const at = lines.findIndex((l) => /^#EXT-X-STREAM-INF/i.test(l));
    const variant = lines.slice(at + 1).find((l) => l.trim() && !l.startsWith('#'));
    if (!variant) return null;
    return hlsDuration(new URL(variant.trim(), url).href, depth + 1);
  }

  let total = 0;
  let seen = false;
  for (const line of lines) {
    const match = /^#EXTINF:\s*([\d.]+)/i.exec(line);
    if (!match) continue;
    total += Number.parseFloat(match[1] ?? '0');
    seen = true;
  }
  return seen ? total : null;
}

/**
 * An unknown container is worth one ranged byte. The response says what it
 * really is, and `res.url` is the address after redirects -- which is how the
 * same file ends up listed twice under two different paths.
 */
export async function probe(url: string): Promise<{ kind: Kind; url: string } | null> {
  const res = await remote(url);
  if (!res?.ok) return null;
  const type = res.contentType.toLowerCase();
  const kind: Kind = /mpegurl/.test(type)
    ? 'M3U8'
    : /dash\+xml/.test(type)
      ? 'MPD'
      : /mp4|video\//.test(type)
        ? 'MP4'
        : 'VIDEO';
  return { kind, url: res.finalUrl };
}

/**
 * The background owns the captured urls: it knows which episode each was
 * captured under, so it does the filtering and the ordering.
 */
export async function requestMedia(tabId: number | undefined): Promise<Entry[]> {
  if (tabId === undefined) return [];
  try {
    const media = await browser.runtime.sendMessage({ type: 'kisskh-media', tabId });
    return Array.isArray(media) ? (media as Entry[]) : [];
  } catch {
    return [];
  }
}
