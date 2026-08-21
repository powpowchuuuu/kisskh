import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { Checkbox } from '@base-ui-components/react/checkbox';
import { Collapsible } from '@base-ui-components/react/collapsible';
import { Menu } from '@base-ui-components/react/menu';
import { Tabs } from '@base-ui-components/react/tabs';
import {
  DEFAULT_LANGS,
  LANGS_KEY,
  LANGUAGES,
  META_KEY,
  SERVER_KEY,
  type DramaMeta,
  type ServerConfig,
  countEpisodes,
  fetchDrama,
  getDramaId,
  getEpisodeId,
  isKisskhUrl,
  type KisskhDrama,
} from '@/utils/kisskh';

const VIDEO_KEY = 'kisskh-video';
const NAMES_KEY = 'kisskh-names';

type Kind = 'M3U8' | 'MPD' | 'MP4' | 'VIDEO' | 'SRT' | 'VTT' | 'SUB';

/** One captured url as the background hands it over. */
interface Entry {
  url: string;
  ep: string | null;
  /** How the background classified it; the url alone is not always enough. */
  kind?: 'video' | 'sub';
  /** Language of a subtitle track, when the page told us. */
  label?: string;
}

/** Not an Entry: `kind` narrows from the background's two-way split to the
 *  format actually shown on the card. */
interface Item {
  url: string;
  ep: string | null;
  kind: Kind;
  /** Language of a subtitle track; what tells two tracks apart. */
  label?: string;
  /** Episode number this url came from, not the one the tab is showing. */
  episode: number | null;
  /** Editable, defaults to "<Drama> Episode <n> kisskh.mp4". */
  name: string;
  /** Seconds, read from the playlist. Null while loading or unavailable. */
  duration: number | null;
}

interface Ready {
  status: 'ready';
  drama: KisskhDrama | null;
  /** Why the drama could not be read, when it could not. */
  dramaError?: string;
  items: Item[];
  tabId: number | undefined;
  origin: string;
}

type State =
  | { status: 'loading' }
  | { status: 'idle'; message: string }
  | Ready;

function kindOf(url: string, stored?: 'video' | 'sub'): Kind {
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
function resourceKey(url: string): string {
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
function labelFromUrl(url: string): string | undefined {
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

/** Strips what the filesystem and the downloads API will not take. */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'video.mp4';
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** One reply from the background's fetch proxy. */
interface Fetched {
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
async function remote(url: string, text = false): Promise<Fetched | null> {
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
async function hlsDuration(url: string, depth = 0): Promise<number | null> {
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
async function probe(url: string): Promise<{ kind: Kind; url: string } | null> {
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

/** kisskh gates the stream on a Referer, so hand it to the tool as well. */
function ffmpegCommand(item: Item, origin: string): string {
  return `ffmpeg -referer "${origin}/" -i "${item.url}" -c copy -bsf:a aac_adtstoasc "${safeName(item.name)}"`;
}

function ytDlpCommand(item: Item, origin: string): string {
  return `yt-dlp --referer "${origin}/" -o "${safeName(item.name)}" "${item.url}"`;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers where clipboard access is not granted.
    const input = document.createElement('textarea');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    return ok;
  }
}

/**
 * The background owns the captured urls: it knows which episode each was
 * captured under, so it does the filtering and the ordering.
 */
async function requestMedia(tabId: number | undefined): Promise<Entry[]> {
  if (tabId === undefined) return [];
  try {
    const media = await browser.runtime.sendMessage({ type: 'kisskh-media', tabId });
    return Array.isArray(media) ? (media as Entry[]) : [];
  } catch {
    return [];
  }
}

/**
 * The popup runs on the extension origin, the page does not. Ask the page
 * first: it is same-origin with the api and already carries the session.
 * Falling back to a direct fetch keeps this working when no content script
 * has been injected into the tab yet.
 */
async function loadDrama(
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

async function load(): Promise<State> {
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

/* ------------------------------------------------------------------ parts -- */

const PLAYLIST = new Set<Kind>(['M3U8', 'MPD']);

function isSubtitle(kind: Kind): boolean {
  return kind === 'SRT' || kind === 'VTT' || kind === 'SUB';
}

/** The second line of a row: what distinguishes this file from its siblings. */
function metaOf(item: Item): string {
  if (isSubtitle(item.kind)) return item.label ?? 'unknown language';
  if (item.kind === 'VIDEO') return 'format not resolved yet';
  if (PLAYLIST.has(item.kind)) {
    return item.duration === null
      ? 'playlist'
      : `playlist · ${formatDuration(item.duration)}`;
  }
  return item.duration === null ? item.kind : `${item.kind} · ${formatDuration(item.duration)}`;
}

function episodeLabel(episode: number | null): string {
  return episode === null ? 'Episode ?' : `Episode ${String(episode).padStart(2, '0')}`;
}

const Check = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 8.5 L6.5 12 L13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const ChevronDown = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 5.5 L8 11 L13 5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const ChevronRight = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M5.5 3 L11 8 L5.5 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const Dots = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="3" cy="8" r="1.4" fill="currentColor" />
    <circle cx="8" cy="8" r="1.4" fill="currentColor" />
    <circle cx="13" cy="8" r="1.4" fill="currentColor" />
  </svg>
);

/** Small uppercase label, the system's recurring section marker. */
function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] tracking-[0.1em] text-neutral-700 uppercase">{children}</div>
  );
}

/**
 * A plain-text listing meant to be pasted elsewhere: the release name on top,
 * then each episode followed by the subtitles that belong to it, every line
 * carrying the url it points at.
 */
function buildNote(title: string, meta: DramaMeta, items: readonly Item[]): string {
  const lines = [`NAME : ${meta.name?.trim() || title}`, ''];

  const byEpisode = new Map<number | null, Item[]>();
  for (const item of items) {
    const group = byEpisode.get(item.episode) ?? [];
    group.push(item);
    byEpisode.set(item.episode, group);
  }

  const episodes = [...byEpisode.keys()].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));

  for (const episode of episodes) {
    const group = byEpisode.get(episode) ?? [];
    const name = episodeLabel(episode);
    for (const video of group.filter((item) => !isSubtitle(item.kind))) {
      lines.push(`${name} : ${video.url}`);
    }
    for (const sub of group.filter((item) => isSubtitle(item.kind))) {
      lines.push(`Sub-${sub.label ?? 'unknown'} : ${sub.url}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Everything the extension knows, shaped for a receiving server: when it was
 * sent, where it came from, the drama, then every episode with its videos and
 * its subtitle tracks. Stamped at build time so the preview shows the same
 * instant the request will carry.
 */
function buildPayload(
  drama: KisskhDrama | null,
  meta: DramaMeta,
  items: readonly Item[],
  origin: string,
) {
  const now = new Date();

  const byEpisode = new Map<number | null, Item[]>();
  for (const item of items) {
    const group = byEpisode.get(item.episode) ?? [];
    group.push(item);
    byEpisode.set(item.episode, group);
  }

  const episodes = [...byEpisode.keys()]
    .sort((a, b) => (a ?? Infinity) - (b ?? Infinity))
    .map((episode) => {
      const group = byEpisode.get(episode) ?? [];
      return {
        number: episode,
        videos: group
          .filter((item) => !isSubtitle(item.kind))
          .map((item) => ({
            url: item.url,
            format: item.kind,
            filename: item.name,
            durationSeconds: item.duration,
          })),
        subtitles: group
          .filter((item) => isSubtitle(item.kind))
          .map((item) => ({
            url: item.url,
            format: item.kind,
            language: item.label ?? null,
            filename: item.name,
          })),
      };
    });

  return {
    sentAt: now.toISOString(),
    sentAtLocal: now.toLocaleString('en-GB', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    source: origin,
    release: meta.name?.trim() || drama?.title || null,
    drama: drama
      ? {
          title: drama.title,
          type: drama.type,
          status: drama.status,
          country: drama.country,
          episodesInCatalogue: drama.episodesCount,
          thumbnail: drama.thumbnail ?? null,
        }
      : null,
    episodes,
    counts: {
      episodes: episodes.length,
      files: items.length,
      videos: items.filter((item) => !isSubtitle(item.kind)).length,
      subtitles: items.filter((item) => isSubtitle(item.kind)).length,
    },
  };
}

/* -------------------------------------------------------------------- row -- */

function Row({
  item,
  origin,
  onRename,
  onDismiss,
}: {
  item: Item;
  origin: string;
  onRename: (name: string) => void;
  onDismiss: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(item.name);
  /** Confirms an action under the row rather than over the popup. */
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(id);
  }, [flash]);

  const commit = () => {
    setRenaming(false);
    const next = draft.trim();
    if (next && next !== item.name) onRename(next);
    else setDraft(item.name);
  };

  const copyAs = async (label: string, text: string) =>
    setFlash((await copy(text)) ? label : 'Copy failed');

  const playlist = PLAYLIST.has(item.kind);

  const download = async () => {
    try {
      await browser.downloads.download({ url: item.url, filename: safeName(item.name) });
      setFlash('Download started');
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Download failed');
    }
  };

  const primaryLabel = playlist
    ? 'Copy command'
    : item.kind === 'VIDEO'
      ? 'Resolve'
      : 'Download';

  return (
    <div className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[9px] px-[14px] py-[7px] hover:bg-ink/6">
      <div className="min-w-0">
        {renaming ? (
          <input
            className="input min-h-[26px] px-[6px] py-[2px] text-[12.5px]"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setDraft(item.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <div className="truncate text-[12.5px] leading-[1.35]" title={item.url}>
            {item.name}
          </div>
        )}

        <div className="mt-px flex items-center gap-[7px] text-[11px] text-neutral-700">
          <span className="truncate">{metaOf(item)}</span>
        </div>

        {flash && (
          <div className="mt-[2px] inline-flex animate-[fbIn_140ms_ease-out] items-center gap-[5px] text-[11px] text-accent-700">
            <Check />
            {flash}
          </div>
        )}
      </div>

      <div className="flex items-center gap-[2px]">
        {/* A playlist has no single sane action, so its primary opens the menu. */}
        {playlist ? (
          <Menu.Root>
            <Menu.Trigger className="inline-flex cursor-pointer items-center gap-[5px] rounded-md px-2 py-1 font-heading text-[11.5px] text-accent-700 hover:bg-accent/12">
              {primaryLabel}
            </Menu.Trigger>
            <MenuPopup>
              <MenuItem onClick={() => void copyAs('ffmpeg command copied', ffmpegCommand(item, origin))}>
                ffmpeg command
              </MenuItem>
              <MenuItem onClick={() => void copyAs('yt-dlp command copied', ytDlpCommand(item, origin))}>
                yt-dlp command
              </MenuItem>
            </MenuPopup>
          </Menu.Root>
        ) : (
          <button
            type="button"
            onClick={() => (item.kind === 'VIDEO' ? setFlash('Resolving…') : void download())}
            className="inline-flex cursor-pointer items-center gap-[5px] rounded-md px-2 py-1 font-heading text-[11.5px] text-accent-700 hover:bg-accent/12"
          >
            {primaryLabel}
          </button>
        )}

        <Menu.Root>
          <Menu.Trigger
            aria-label="More actions"
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-neutral-700 hover:bg-ink/10"
          >
            <Dots />
          </Menu.Trigger>
          <MenuPopup>
            <MenuItem onClick={() => void copyAs('URL copied', item.url)}>Copy URL</MenuItem>
            <MenuItem
              onClick={() => {
                setDraft(item.name);
                setRenaming(true);
              }}
            >
              Rename
            </MenuItem>
            {!playlist && (
              <MenuItem onClick={() => void copyAs('yt-dlp command copied', ytDlpCommand(item, origin))}>
                yt-dlp command
              </MenuItem>
            )}
            <MenuItem onClick={onDismiss}>Remove from list</MenuItem>
          </MenuPopup>
        </Menu.Root>
      </div>
    </div>
  );
}

function MenuPopup({ children }: { children: React.ReactNode }) {
  return (
    <Menu.Portal>
      <Menu.Positioner side="bottom" align="end" sideOffset={4}>
        <Menu.Popup className="elev-lg flex min-w-[196px] flex-col rounded-md bg-neutral-100 p-1 outline-none">
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <Menu.Item
      onClick={onClick}
      className="cursor-pointer rounded-sm px-[9px] py-[6px] text-left font-body text-[12.5px] text-ink outline-none hover:bg-ink/8 data-highlighted:bg-ink/8"
    >
      {children}
    </Menu.Item>
  );
}

/* ------------------------------------------------------------------ panes -- */

function Files({
  items,
  origin,
  onRename,
  onDismiss,
}: {
  items: readonly Item[];
  origin: string;
  onRename: (url: string, name: string) => void;
  onDismiss: (url: string) => void;
}) {
  const groups = new Map<number | null, Item[]>();
  for (const item of items) {
    const group = groups.get(item.episode) ?? [];
    group.push(item);
    groups.set(item.episode, group);
  }
  // Newest first. Every group starts open, so the state only ever holds the
  // ones the reader has deliberately folded away.
  const episodes = [...groups.keys()].sort((a, b) => (b ?? -Infinity) - (a ?? -Infinity));
  const [closed, setClosed] = useState<Set<string>>(new Set());

  return (
    <div className="max-h-[440px] overflow-auto pt-[6px] pb-[10px]">
      {episodes.map((episode) => {
        const key = String(episode);
        const files = groups.get(episode) ?? [];
        const open = !closed.has(key);

        return (
          <Collapsible.Root
            key={key}
            open={open}
            onOpenChange={(next) =>
              setClosed((prev) => {
                const folded = new Set(prev);
                if (next) folded.delete(key);
                else folded.add(key);
                return folded;
              })
            }
            className="pt-[6px]"
          >
            <Collapsible.Trigger className="flex w-full cursor-pointer items-center gap-[7px] px-[14px] py-[6px] text-left font-heading text-[12px] tracking-[0.07em] text-ink uppercase hover:bg-ink/6">
              {open ? <ChevronDown /> : <ChevronRight />}
              <span>{episodeLabel(episode)}</span>
              <span className="font-body text-[11.5px] tracking-normal text-neutral-700 normal-case">
                {files.length} {files.length > 1 ? 'files' : 'file'}
              </span>
            </Collapsible.Trigger>

            <Collapsible.Panel className="flex flex-col">
              {files.map((item) => (
                <Row
                  key={item.url}
                  item={item}
                  origin={origin}
                  onRename={(name) => onRename(item.url, name)}
                  onDismiss={() => onDismiss(item.url)}
                />
              ))}
            </Collapsible.Panel>
          </Collapsible.Root>
        );
      })}
    </div>
  );
}

function Note({
  title,
  meta,
  items,
  onChange,
}: {
  title: string;
  meta: DramaMeta;
  items: readonly Item[];
  onChange: (patch: DramaMeta) => void;
}) {
  const text = buildNote(title, meta, items);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <div className="flex flex-col gap-[10px] p-[14px]">
      <div>
        <label htmlFor="release" className="mb-1 block">
          <Kicker>Release name</Kicker>
        </label>
        <input
          id="release"
          className="input min-h-[30px] text-[12.5px]"
          value={meta.name ?? ''}
          placeholder={title}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </div>

      <div>
        <div className="mb-1">
          <Kicker>
            Listing · {items.length} URL{items.length > 1 ? 's' : ''}
          </Kicker>
        </div>
        <pre className="m-0 max-h-[200px] overflow-auto rounded-md bg-surface px-[10px] py-[9px] font-mono text-[10.5px] leading-[1.7] whitespace-pre text-neutral-800">
          {text}
        </pre>
      </div>

      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={async () => setCopied(await copy(text))}
      >
        {copied ? 'Copied' : 'Copy block'}
      </button>
    </div>
  );
}

function Settings({
  chosen,
  counts,
  onToggle,
}: {
  chosen: string[];
  counts: Record<string, number>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 p-[14px]">
      <div>
        <Kicker>Subtitle languages</Kicker>
        <div className="mt-[3px] text-[11.5px] text-neutral-700">
          Other languages are captured but hidden.
        </div>
      </div>

      <div className="flex flex-col">
        {LANGUAGES.map((lang) => {
          const on = chosen.includes(lang.id);
          const count = counts[lang.id] ?? 0;
          return (
            <label
              key={lang.id}
              className="flex cursor-pointer items-center gap-[9px] px-1 py-[7px] text-[13px] hover:bg-ink/6"
            >
              <Checkbox.Root
                checked={on}
                onCheckedChange={() => onToggle(lang.id)}
                className={`inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-paper ${
                  on ? 'bg-accent' : 'bg-surface shadow-[inset_0_0_0_1px_var(--color-neutral-400)]'
                }`}
              >
                <Checkbox.Indicator>
                  <Check />
                </Checkbox.Indicator>
              </Checkbox.Root>
              <span>{lang.label}</span>
              <span className="ml-auto text-[11px] text-neutral-700">
                {count > 0 && `${count} ${count > 1 ? 'files' : 'file'}`}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function Server({
  config,
  onChange,
  makePayload,
}: {
  config: ServerConfig;
  onChange: (patch: ServerConfig) => void;
  /** Called again at send time: the payload carries the instant it left. */
  makePayload: () => unknown;
}) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const preview = JSON.stringify(makePayload(), null, 2);

  const send = async () => {
    const url = config.url?.trim();
    if (!url) {
      setResult({ ok: false, text: 'Enter a URL first.' });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const reply = (await browser.runtime.sendMessage({
        type: 'kisskh-push',
        url,
        token: config.token,
        payload: makePayload(),
      })) as { ok: boolean; status: number; body: string } | undefined;

      if (reply?.ok) {
        const at = new Date();
        onChange({ lastSentAt: at.toISOString() });
        setResult({ ok: true, text: `Sent on ${at.toLocaleString('en-GB')}` });
      } else if (reply?.status) {
        setResult({
          ok: false,
          text: `Refused · HTTP ${reply.status}${reply.body ? ` · ${reply.body}` : ''}`,
        });
      } else {
        setResult({ ok: false, text: `Unreachable · ${reply?.body ?? 'no response'}` });
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-[10px] p-[14px]">
      <div>
        <label htmlFor="server-url" className="mb-1 block">
          <Kicker>Server or NAS URL</Kicker>
        </label>
        <input
          id="server-url"
          className="input min-h-[30px] text-[12.5px]"
          value={config.url ?? ''}
          placeholder="https://nas.local:8080/kisskh"
          onChange={(e) => onChange({ url: e.target.value })}
        />
      </div>

      <div>
        <label htmlFor="server-token" className="mb-1 block">
          <Kicker>Auth token</Kicker>
        </label>
        <input
          id="server-token"
          type="password"
          className="input min-h-[30px] text-[12.5px]"
          value={config.token ?? ''}
          placeholder="leave empty if the server needs none"
          onChange={(e) => onChange({ token: e.target.value })}
        />
        <div className="mt-[3px] text-[11px] text-neutral-700">
          Sent as an <code>X-Token</code> header.
        </div>
      </div>

      <div>
        <div className="mb-1">
          <Kicker>Payload · POST JSON · stamped when sent</Kicker>
        </div>
        <pre className="m-0 max-h-[180px] overflow-auto rounded-md bg-surface px-[10px] py-[9px] font-mono text-[10.5px] leading-[1.7] whitespace-pre text-neutral-800">
          {preview}
        </pre>
      </div>

      {result && (
        <div
          className={`text-[11.5px] ${result.ok ? 'text-accent-700' : 'text-flag-700'}`}
        >
          {result.text}
        </div>
      )}

      {!result && config.lastSentAt && (
        <div className="text-[11.5px] text-neutral-700">
          Last sent on {new Date(config.lastSentAt).toLocaleString('en-GB')}
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={sending}
        onClick={() => void send()}
      >
        {sending ? 'Sending…' : 'Send to server'}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------- app -- */

function App() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [chosen, setChosen] = useState<string[]>([...DEFAULT_LANGS]);
  const [meta, setMeta] = useState<DramaMeta>({});
  const [server, setServer] = useState<ServerConfig>({});
  const [view, setView] = useState('files');
  const [busy, setBusy] = useState(false);
  const durationsFor = useRef<string>('');
  const probed = useRef<Set<string>>(new Set());

  // Reloading does not blank what is on screen: the first render already
  // starts in `loading`, so later reloads just swap the result in.
  const refresh = useCallback(() => {
    setBusy(true);
    void load().then((next) => {
      setState(next);
      setBusy(false);
    });
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    void browser.storage.local.get([LANGS_KEY, SERVER_KEY]).then((stored) => {
      const saved = stored[LANGS_KEY];
      if (Array.isArray(saved)) setChosen(saved as string[]);
      const target = stored[SERVER_KEY];
      if (target && typeof target === 'object') setServer(target as ServerConfig);
    });
  }, []);

  // Global, not per drama: it is the user's own server either way.
  const saveServer = (patch: ServerConfig) => {
    setServer((prev) => {
      const next = { ...prev, ...patch };
      void browser.storage.local.set({ [SERVER_KEY]: next });
      return next;
    });
  };

  // Read the playlists once per url set, after the list is on screen.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const key = state.items.map((i) => i.url).join(' ');
    if (!key || key === durationsFor.current) return;
    durationsFor.current = key;

    let live = true;
    for (const item of state.items) {
      if (item.kind !== 'M3U8') continue;
      void hlsDuration(item.url)
        .then((duration) => {
          if (!live || duration === null) return;
          setState((prev) =>
            prev.status !== 'ready'
              ? prev
              : {
                  ...prev,
                  items: prev.items.map((i) => (i.url === item.url ? { ...i, duration } : i)),
                },
          );
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [state]);

  // Resolve anything we could not name from its url alone. Each url once.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const unknown = state.items.filter(
      (item) => item.kind === 'VIDEO' && !probed.current.has(item.url),
    );
    if (!unknown.length) return;
    for (const item of unknown) probed.current.add(item.url);

    let live = true;
    for (const item of unknown) {
      void probe(item.url).then((result) => {
        if (!live || !result) return;
        setState((prev) => {
          if (prev.status !== 'ready') return prev;
          const resolved = resourceKey(result.url);
          const duplicate = prev.items.some(
            (other) => other.url !== item.url && resourceKey(other.url) === resolved,
          );
          return {
            ...prev,
            items: duplicate
              ? prev.items.filter((other) => other.url !== item.url)
              : prev.items.map((other) =>
                  other.url === item.url ? { ...other, kind: result.kind } : other,
                ),
          };
        });
      });
    }
    return () => {
      live = false;
    };
  }, [state]);

  const dramaId = state.status === 'ready' ? state.drama?.id : undefined;

  useEffect(() => {
    if (dramaId === undefined) return;
    void browser.storage.local.get(META_KEY).then((stored) => {
      const all = (stored[META_KEY] as Record<string, DramaMeta> | undefined) ?? {};
      setMeta(all[String(dramaId)] ?? {});
    });
  }, [dramaId]);

  const saveMeta = async (patch: DramaMeta) => {
    const next = { ...meta, ...patch };
    setMeta(next);
    if (dramaId === undefined) return;
    const stored = await browser.storage.local.get(META_KEY);
    const all = (stored[META_KEY] as Record<string, DramaMeta> | undefined) ?? {};
    await browser.storage.local.set({ [META_KEY]: { ...all, [String(dramaId)]: next } });
  };

  /**
   * Removals apply on the spot. The background owns the list, but waiting for
   * the round trip and reloading everything meant dropping one row blanked the
   * popup and re-fetched the drama. On failure we resync.
   */
  const drop = (keep: (item: Item) => boolean, message: object) => {
    if (state.status !== 'ready') return;
    const tabId = state.tabId;
    setState((prev) =>
      prev.status !== 'ready' ? prev : { ...prev, items: prev.items.filter(keep) },
    );
    void browser.runtime.sendMessage({ ...message, tabId }).catch(refresh);
  };

  const rename = async (url: string, name: string) => {
    const { [NAMES_KEY]: saved } = await browser.storage.local.get(NAMES_KEY);
    const names = { ...((saved as Record<string, string> | undefined) ?? {}), [url]: name };
    await browser.storage.local.set({ [NAMES_KEY]: names });
    setState((prev) =>
      prev.status !== 'ready'
        ? prev
        : { ...prev, items: prev.items.map((i) => (i.url === url ? { ...i, name } : i)) },
    );
  };

  // The background reads this straight from storage and drops its cache on
  // change, so reloading the list is all that is needed here.
  const toggleLang = async (id: string) => {
    const next = chosen.includes(id)
      ? chosen.filter((other) => other !== id)
      : [...chosen, id];
    setChosen(next);
    await browser.storage.local.set({ [LANGS_KEY]: next });
    refresh();
  };

  const ready = state.status === 'ready' ? state : null;
  const items = ready?.items ?? [];
  const counts = ready?.drama ? countEpisodes(ready.drama) : null;
  const title = ready?.drama?.title ?? meta.name ?? 'kisskh';

  const episodeCount = new Set(items.map((i) => i.episode)).size;
  const langCounts: Record<string, number> = {};
  for (const item of items) {
    if (!isSubtitle(item.kind) || !item.label) continue;
    const lang = LANGUAGES.find((l) => l.code.test(item.label ?? ''));
    if (lang) langCounts[lang.id] = (langCounts[lang.id] ?? 0) + 1;
  }

  const status =
    state.status === 'loading' ? 'Detecting…' : items.length ? 'Capture active' : 'Waiting';

  return (
    <div>
      <div className="px-[14px] pt-[14px]">
        <div className="flex items-center gap-2">
          <Kicker>kisskh grab</Kicker>
          <span className="ml-auto inline-flex items-center gap-[5px] text-[11px] text-accent-700">
            {items.length > 0 && (
              <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                <circle cx="4" cy="4" r="4" fill="currentColor" opacity="0.25" />
                <circle cx="4" cy="4" r="2" fill="currentColor" />
              </svg>
            )}
            {status}
          </span>
        </div>

        {state.status === 'loading' ? (
          <div className="mt-4 flex flex-col gap-[9px]">
            <div className="h-[15px] w-[58%] rounded-sm bg-neutral-300" />
            <div className="h-[10px] w-[34%] rounded-sm bg-neutral-200" />
            <div className="mt-2 h-[10px] w-[76%] rounded-sm bg-neutral-200" />
            <div className="h-[10px] w-[64%] rounded-sm bg-neutral-200" />
          </div>
        ) : state.status === 'idle' ? (
          <div className="pb-[14px]">
            <h3 className="mt-4 mb-1 text-[18px]">Nothing to capture here</h3>
            <p className="mb-[14px] max-w-[300px] text-[12.5px] text-neutral-700">
              {state.message}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void browser.tabs.create({ url: 'https://kisskh.co' })}
            >
              Open kisskh.co
            </button>
          </div>
        ) : (
          <>
            {ready?.dramaError && (
              <div className="mt-[14px]">
                <div className="text-[12.5px] font-semibold text-flag-700">
                  Title not found on the page
                </div>
                <div className="mt-[2px] text-[12px] text-neutral-700">
                  Files keep their raw names. Set a release name in the Note tab
                  to rename them.
                </div>
              </div>
            )}

            <h2 className="mt-[11px] mb-[2px] text-[21px]">{title}</h2>
            <div className="text-[11.5px] text-neutral-700">
              {episodeCount > 0 && `${episodeCount} ${episodeCount > 1 ? 'episodes' : 'episode'} · `}
              {items.length} {items.length > 1 ? 'files captured' : 'file captured'}
              {counts ? ` · ${counts.total} in the catalogue` : ''}
            </div>
          </>
        )}
      </div>

      {ready && (
        <Tabs.Root value={view} onValueChange={(next) => setView(String(next))}>
          <Tabs.List className="mt-3 flex gap-[18px] px-[14px]">
            {[
              ['files', 'Files'],
              ['note', 'Note'],
              ['settings', 'Settings'],
              ['server', 'Server'],
            ].map(([id, label]) => (
              <Tabs.Tab
                key={id}
                value={id}
                className={`cursor-pointer border-0 bg-transparent pb-[7px] font-heading text-[12px] tracking-[0.06em] uppercase ${
                  view === id
                    ? 'text-ink shadow-[inset_0_-2px_0_var(--color-accent)]'
                    : 'text-neutral-700'
                }`}
              >
                {label}
              </Tabs.Tab>
            ))}
          </Tabs.List>

          <Tabs.Panel value="files">
            {items.length > 0 ? (
              <Files
                items={items}
                origin={ready.origin}
                onRename={(url, name) => void rename(url, name)}
                onDismiss={(url) =>
                  drop((other) => other.url !== url, { type: 'kisskh-dismiss', url })
                }
              />
            ) : (
              <div className="p-[14px]">
                <p className="mb-[14px] max-w-[320px] text-[12.5px] text-neutral-700">
                  Nothing has come through yet. Start playback for a few seconds and
                  the video and subtitles will appear here.
                </p>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={refresh}>
                  {busy ? 'Detecting…' : 'Run detection again'}
                </button>
              </div>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="note">
            <Note
              title={ready.drama?.title ?? ''}
              meta={meta}
              items={items}
              onChange={(patch) => void saveMeta(patch)}
            />
          </Tabs.Panel>

          <Tabs.Panel value="server">
            <Server
              config={server}
              onChange={saveServer}
              makePayload={() =>
                buildPayload(ready.drama, meta, items, ready.origin)
              }
            />
          </Tabs.Panel>

          <Tabs.Panel value="settings">
            <Settings
              chosen={chosen}
              counts={langCounts}
              onToggle={(id) => void toggleLang(id)}
            />
          </Tabs.Panel>
        </Tabs.Root>
      )}
    </div>
  );
}

export default App;
