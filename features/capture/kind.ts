/** Telling one capture from another, and saying so in a row. */
import { formatDuration } from '@/features/capture/naming';
import type { Item, Kind } from '@/features/capture/types';

export function kindOf(url: string, stored?: 'video' | 'sub'): Kind {
  if (/\.mpd(\?|$)/i.test(url)) return 'MPD';
  if (/\.mp4(\?|$)/i.test(url)) return 'MP4';
  if (/\.srt(\?|$|\/)/i.test(url)) return 'SRT';
  if (/\.vtt(\?|$|\/)/i.test(url)) return 'VTT';
  if (/\.(txt1?|ass|ssa)(\?|$|\/)/i.test(url)) return 'SUB';
  if (/\.m3u8(\?|$)/i.test(url)) return 'M3U8';
  if (stored === 'sub') return 'SUB';
  // No usable extension. Claiming M3U8 here was wrong: an unknown url is not
  // evidence of a playlist, and it sent people to ffmpeg for a plain file.
  return 'VIDEO';
}

/**
 * The page hook and the webRequest watcher can see the same file under two
 * urls that differ only by a signing token, which showed up as the same video
 * listed twice. What identifies the resource is host plus path.
 */
export function resourceKey(url: string): string {
  try {
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
  } catch {
    return url;
  }
}

/**
 * Last resort when the page named no language: the file name usually is one,
 * e.g. ".../Record.of.Youth-English.srt" -> "Record of Youth English".
 */
export function labelFromUrl(url: string): string | undefined {
  try {
    const file = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    const stem = file
      .replace(/\.(srt|vtt|ass|ssa|txt1?)$/i, '')
      .replace(/[._-]+/g, ' ')
      .trim();
    return stem || undefined;
  } catch {
    return undefined;
  }
}

export const PLAYLIST = new Set<Kind>(['M3U8', 'MPD']);

export function isSubtitle(kind: Kind): boolean {
  return kind === 'SRT' || kind === 'VTT' || kind === 'SUB';
}

/** The second line of a row: what distinguishes this file from its siblings. */
export function metaOf(item: Item): string {
  if (isSubtitle(item.kind)) return item.label ?? 'unknown language';
  if (item.kind === 'VIDEO') return 'format not resolved yet';
  if (PLAYLIST.has(item.kind)) {
    return item.duration === null
      ? 'playlist'
      : `playlist · ${formatDuration(item.duration)}`;
  }
  return item.duration === null ? item.kind : `${item.kind} · ${formatDuration(item.duration)}`;
}

export function episodeLabel(episode: number | null): string {
  return episode === null ? 'Episode ?' : `Episode ${String(episode).padStart(2, '0')}`;
}
