import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { Button } from 'primereact/button';
import { Checkbox } from 'primereact/checkbox';
import { InputText } from 'primereact/inputtext';
import { Menu } from 'primereact/menu';
import { Message } from 'primereact/message';
import {
  DEFAULT_LANGS,
  LANGS_KEY,
  LANGUAGES,
  META_KEY,
  type DramaMeta,
  countEpisodes,
  fetchDrama,
  getDramaId,
  getEpisodeId,
  isKisskhUrl,
  type KisskhDrama,
} from '@/utils/kisskh';
import './App.css';

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

/** Short, fixed-width label for the format tile. */
const KIND_TILE: Record<Kind, string> = {
  M3U8: 'HLS',
  MPD: 'DASH',
  MP4: 'MP4',
  VIDEO: 'VID',
  SRT: 'SRT',
  VTT: 'VTT',
  SUB: 'SUB',
};

function isSubtitle(kind: Kind): boolean {
  return kind === 'SRT' || kind === 'VTT' || kind === 'SUB';
}

/**
 * The saved file keeps its full name, but the row already states the drama in
 * the header and the episode on its own first line, so only what is left of
 * the name carries any information here.
 */
function tail(item: Item, drama: string): string {
  const prefix = `${drama}${item.episode === null ? '' : ` Episode ${item.episode}`}`;
  const rest = drama && item.name.startsWith(prefix)
    ? item.name.slice(prefix.length).trim()
    : item.name;
  return rest || item.name;
}

/**
 * A plain-text listing meant to be pasted elsewhere: the release details on
 * top, then each episode followed by the subtitles that belong to it, every
 * line carrying the url it points at.
 */
function buildNote(
  title: string,
  meta: DramaMeta,
  items: readonly Item[],
): string {
  const lines = [`NAME : ${meta.name?.trim() || title}`, ''];

  const byEpisode = new Map<number | null, Item[]>();
  for (const item of items) {
    const group = byEpisode.get(item.episode) ?? [];
    group.push(item);
    byEpisode.set(item.episode, group);
  }

  const episodes = [...byEpisode.keys()].sort(
    (a, b) => (a ?? Infinity) - (b ?? Infinity),
  );

  for (const episode of episodes) {
    const group = byEpisode.get(episode) ?? [];
    const name = episode === null ? 'Episode ?' : `Episode ${episode}`;
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

  // Self-clearing, so nothing has to be torn down by hand.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <div className="pane">
      <div className="fields">
        <label className="field">
          <span>Name</span>
          <InputText
            className="p-inputtext-sm"
            value={meta.name ?? ''}
            placeholder={title}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>
      </div>

      {/* Copy sits above the listing: the listing grows with the episode
          count, and a button under it would scroll out of reach. */}
      <div className="note-head">
        <span>Preview</span>
        <Button
          label={copied ? 'Copied' : 'Copy'}
          icon={copied ? 'pi pi-check' : 'pi pi-copy'}
          size="small"
          text
          onClick={async () => setCopied(await copy(text))}
        />
      </div>

      <pre className="note">{text}</pre>
    </div>
  );
}

function Row({
  item,
  origin,
  strip,
  onRename,
  onDismiss,
}: {
  item: Item;
  origin: string;
  /** Drama title, already in the header and so redundant on every row. */
  strip: string;
  onRename: (name: string) => void;
  onDismiss: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.name);
  /** Confirms an action in place of the file line; no overlay, no toast. */
  const [flash, setFlash] = useState<string | null>(null);
  const menu = useRef<Menu>(null);

  // Self-clearing, so nothing has to be torn down by hand.
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(id);
  }, [flash]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== item.name) onRename(next);
    else setDraft(item.name);
  };

  const copyAs = async (what: string, text: string) =>
    setFlash((await copy(text)) ? `${what} copied` : 'Copy failed');

  const sub = isSubtitle(item.kind);
  // Only a playlist needs muxing; anything else is fetched as it stands.
  const direct = item.kind !== 'M3U8' && item.kind !== 'MPD';

  const save = async () => {
    if (!direct) return copyAs('ffmpeg command', ffmpegCommand(item, origin));
    try {
      await browser.downloads.download({ url: item.url, filename: safeName(item.name) });
      setFlash('Download started');
    } catch (err) {
      setFlash(err instanceof Error ? err.message : 'Download failed');
    }
  };

  const menuItems = [
    { label: 'Rename', icon: 'pi pi-pencil', command: () => { setDraft(item.name); setEditing(true); } },
    { label: 'Copy URL', icon: 'pi pi-link', command: () => void copyAs('URL', item.url) },
    ...(sub
      ? []
      : [
          { label: 'Copy ffmpeg', icon: 'pi pi-code', command: () => void copyAs('ffmpeg command', ffmpegCommand(item, origin)) },
          { label: 'Copy yt-dlp', icon: 'pi pi-code', command: () => void copyAs('yt-dlp command', ytDlpCommand(item, origin)) },
        ]),
    { separator: true },
    { label: 'Remove', icon: 'pi pi-trash', command: onDismiss },
  ];

  const episode = item.episode === null ? 'Unknown episode' : `Episode ${item.episode}`;
  const headline = sub ? `${episode} · ${item.label ?? 'Subtitle'}` : episode;

  return (
    <li className={`row${sub ? ' row-sub' : ''}`}>
      <span className={`tile tile-${item.kind.toLowerCase()}`}>{KIND_TILE[item.kind]}</span>

      <div className="row-text">
        {editing ? (
          <InputText
            className="row-rename p-inputtext-sm"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setDraft(item.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <>
            <div className="row-head">
              <span className="row-title">{headline}</span>
              {item.duration !== null && (
                <span className="row-time">{formatDuration(item.duration)}</span>
              )}
            </div>
            <div className={`row-file${flash ? ' row-flash' : ''}`} title={item.name}>
              {flash ?? tail(item, strip)}
            </div>
          </>
        )}
      </div>

      <div className="row-acts">
        <Button
          className="act act-save"
          icon={direct ? 'pi pi-download' : 'pi pi-copy'}
          rounded
          text
          aria-label={direct ? 'Download' : 'Copy ffmpeg command'}
          title={direct ? 'Download' : 'Playlist: copy an ffmpeg command'}
          onClick={() => void save()}
        />
        <Button
          className="act"
          icon="pi pi-ellipsis-v"
          rounded
          text
          severity="secondary"
          aria-label="More"
          onClick={(event) => menu.current?.toggle(event)}
        />
        <Menu model={menuItems} popup ref={menu} />
      </div>
    </li>
  );
}

function Settings({
  chosen,
  onToggle,
}: {
  chosen: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="pane">
      <h2 className="pane-title">Subtitle languages</h2>
      <div className="langs">
        {LANGUAGES.map((lang) => (
          <label key={lang.id} className="lang" htmlFor={`lang-${lang.id}`}>
            <Checkbox
              inputId={`lang-${lang.id}`}
              checked={chosen.includes(lang.id)}
              onChange={() => onToggle(lang.id)}
            />
            <span>{lang.label}</span>
          </label>
        ))}
      </div>
      <p className="hint">
        Applies to tracks already captured, not only the next ones. A track the
        page gives no language to is always kept.
      </p>
    </div>
  );
}

function App() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [chosen, setChosen] = useState<string[]>([...DEFAULT_LANGS]);
  const [view, setView] = useState<'files' | 'note' | 'settings'>('files');
  const [meta, setMeta] = useState<DramaMeta>({});
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
    void browser.storage.local.get(LANGS_KEY).then((stored) => {
      const saved = stored[LANGS_KEY];
      if (Array.isArray(saved)) setChosen(saved as string[]);
    });
  }, []);

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
                  items: prev.items.map((i) =>
                    i.url === item.url ? { ...i, duration } : i,
                  ),
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
    await browser.storage.local.set({
      [META_KEY]: { ...all, [String(dramaId)]: next },
    });
  };

  /**
   * Removals apply on the spot. The background is the owner of the list, but
   * waiting for the round trip and reloading everything meant dropping one
   * row re-fetched the drama and blanked the popup. On failure we resync.
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

  const subtitle = ready
    ? [
        items.length ? `${items.length} file${items.length > 1 ? 's' : ''}` : 'nothing captured',
        counts ? `${counts.total} episodes` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : state.status === 'loading'
      ? 'Reading the page...'
      : '';

  return (
    <div className="app">
      <header className="top">
        <div className="top-text">
          <h1>{ready?.drama?.title ?? 'KissKH'}</h1>
          <p>{subtitle}</p>
        </div>
        <Button
          className="act"
          icon={busy ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'}
          rounded
          text
          severity="secondary"
          aria-label="Refresh"
          disabled={busy}
          onClick={refresh}
        />
      </header>

      <nav className="seg">
        <button
          className={view === 'files' ? 'on' : ''}
          onClick={() => setView('files')}
        >
          Files
          {items.length > 0 && <span className="pill">{items.length}</span>}
        </button>
        <button
          className={view === 'note' ? 'on' : ''}
          onClick={() => setView('note')}
        >
          Note
        </button>
        <button
          className={view === 'settings' ? 'on' : ''}
          onClick={() => setView('settings')}
        >
          Settings
        </button>
      </nav>

      {view === 'settings' ? (
        <Settings chosen={chosen} onToggle={(id) => void toggleLang(id)} />
      ) : view === 'note' ? (
        <Note
          title={ready?.drama?.title ?? ''}
          meta={meta}
          items={items}
          onChange={(patch) => void saveMeta(patch)}
        />
      ) : (
        <div className="pane">
          {state.status === 'loading' && (
            <p className="empty">
              <i className="pi pi-spin pi-spinner" />
            </p>
          )}

          {state.status === 'idle' && <p className="empty">{state.message}</p>}

          {ready?.dramaError && (
            <Message
              className="notice"
              severity="warn"
              text={`No title or episode number: ${ready.dramaError}`}
            />
          )}

          {ready && items.length > 0 && (
            <ul className="rows">
              {items.map((item) => (
                <Row
                  key={item.url}
                  item={item}
                  origin={ready.origin}
                  strip={ready.drama?.title ?? ''}
                          onRename={(name) => void rename(item.url, name)}
                  onDismiss={() =>
                    drop((other) => other.url !== item.url, {
                      type: 'kisskh-dismiss',
                      url: item.url,
                    })
                  }
                />
              ))}
            </ul>
          )}

          {ready && items.length === 0 && (
            <p className="empty">
              <strong>Nothing captured yet</strong>
              <span>Start playing the episode, then refresh.</span>
            </p>
          )}
        </div>
      )}

      {ready && items.length > 0 && view === 'files' && (
        <footer className="bottom">
          <button className="link" onClick={() => void browser.tabs.create({ url: 'chrome://downloads' })}>
            <i className="pi pi-folder-open" /> Downloads
          </button>
          <button
            className="link danger"
            onClick={() => drop(() => false, { type: 'kisskh-clear' })}
          >
            <i className="pi pi-trash" /> Clear list
          </button>
        </footer>
      )}
    </div>
  );
}

export default App;
