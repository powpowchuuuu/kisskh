import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
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

type Kind = 'M3U8' | 'MPD' | 'MP4';

/** One captured url as the background hands it over. */
interface Entry {
  url: string;
  ep: string | null;
}

interface Item extends Entry {
  kind: Kind;
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
  items: Item[];
  tabId: number | undefined;
  origin: string;
}

type State =
  | { status: 'loading' }
  | { status: 'idle'; message: string }
  | Ready;

function kindOf(url: string): Kind {
  if (/\.mpd(\?|$)/i.test(url)) return 'MPD';
  if (/\.mp4(\?|$)/i.test(url)) return 'MP4';
  return 'M3U8';
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

/**
 * Sums the playlist's own #EXTINF values. A master playlist has no segments of
 * its own, so we follow its first variant.
 */
async function hlsDuration(url: string, depth = 0): Promise<number | null> {
  if (depth > 2) return null;
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) return null;
  const text = await res.text();
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
  // The page hook only ever holds the episode on screen; the background has
  // the rest of the season.
  if (hooked && !entries.some((e) => e.url === hooked)) entries.push({ url: hooked, ep });

  let drama: KisskhDrama | null = null;
  try {
    drama = await fetchDrama(origin, id);
  } catch {
    // The list still works without the title; only the naming gets duller.
  }

  const numberOf = new Map(
    (drama?.episodes ?? []).map((e) => [String(e.id), e.number] as const),
  );

  const { [NAMES_KEY]: savedNames } = await browser.storage.local.get(NAMES_KEY);
  const names = (savedNames as Record<string, string> | undefined) ?? {};

  const seen = new Set<string>();
  const items: Item[] = [];
  for (const entry of entries) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    const episode = entry.ep === null ? null : (numberOf.get(entry.ep) ?? null);
    const base = drama
      ? `${drama.title}${episode === null ? '' : ` Episode ${episode}`} kisskh.mp4`
      : 'kisskh.mp4';
    items.push({
      url: entry.url,
      ep: entry.ep,
      episode,
      kind: kindOf(entry.url),
      name: names[entry.url] ?? base,
      duration: null,
    });
  }
  // Episode order, so the list reads 1, 2, 3 however you browsed them.
  items.sort((a, b) => (a.episode ?? Infinity) - (b.episode ?? Infinity));

  return { status: 'ready', drama, tabId: tab?.id, origin, items };
}

function Icon({ path, size = 16 }: { path: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ICONS = {
  close: 'M18 6 6 18M6 6l12 12',
  pencil: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  chevron: 'm6 9 6 6 6-6',
  trash: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6',
  folder: 'M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z',
  refresh: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  help: 'M9.1 9a3 3 0 1 1 4 2.8c-.8.3-1.1 1-1.1 1.7v.5M12 17.5v.5',
};

function Card({
  item,
  origin,
  thumbnail,
  onRename,
  onDismiss,
}: {
  item: Item;
  origin: string;
  thumbnail: string | undefined;
  onRename: (name: string) => void;
  onDismiss: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.name);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 1600);
  };

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== item.name) onRename(next);
    else setDraft(item.name);
  };

  const run = async (label: string, text: string) => {
    setMenu(false);
    flash((await copy(text)) ? label : 'Copy failed');
  };

  // An .m3u8 is a manifest, not a video: only a direct file can be fetched.
  const direct = item.kind === 'MP4';

  const primary = async () => {
    if (!direct) return run('ffmpeg command copied', ffmpegCommand(item, origin));
    setMenu(false);
    try {
      await browser.downloads.download({ url: item.url, filename: safeName(item.name) });
      flash('Download started');
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Download failed');
    }
  };

  return (
    <li className="card">
      <button className="card-close" title="Remove" onClick={onDismiss}>
        <Icon path={ICONS.close} size={15} />
      </button>

      <div className="thumb">
        {thumbnail ? <img src={thumbnail} alt="" /> : <div className="thumb-blank" />}
        {item.duration !== null && (
          <span className="thumb-time">{formatDuration(item.duration)}</span>
        )}
      </div>

      <div className="card-body">
        <div className="card-title">
          <span className={`badge badge-${item.kind.toLowerCase()}`}>{item.kind}</span>
          {editing ? (
            <input
              className="rename"
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
            <span className="name" title={item.url}>{item.name}</span>
          )}
        </div>

        <div className="card-actions">
          <button
            className="ghost"
            title="Rename"
            onClick={() => {
              setDraft(item.name);
              setEditing(true);
            }}
          >
            <Icon path={ICONS.pencil} size={15} />
          </button>

          {toast && <span className="toast">{toast}</span>}

          <div className="split">
            <button className="primary" onClick={primary}>
              <Icon path={ICONS.download} size={15} />
              {direct ? 'Download' : 'Copy ffmpeg'}
            </button>
            <button
              className="primary chevron"
              title="More"
              onClick={() => setMenu((open) => !open)}
            >
              <Icon path={ICONS.chevron} size={15} />
            </button>
          </div>
        </div>

        {/* Inline rather than floating: a popup clips anything that overflows. */}
        {menu && (
          <ul className="menu">
            <li>
              <button onClick={() => run('URL copied', item.url)}>Copy stream URL</button>
            </li>
            <li>
              <button onClick={() => run('ffmpeg command copied', ffmpegCommand(item, origin))}>
                Copy ffmpeg command
              </button>
            </li>
            <li>
              <button onClick={() => run('yt-dlp command copied', ytDlpCommand(item, origin))}>
                Copy yt-dlp command
              </button>
            </li>
          </ul>
        )}
      </div>
    </li>
  );
}

function App() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [help, setHelp] = useState(false);
  const durationsFor = useRef<string>('');

  const refresh = useCallback(() => {
    setState({ status: 'loading' });
    void load().then(setState);
  }, []);

  useEffect(refresh, [refresh]);

  // Read the playlists once per url set, after the list is on screen.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const key = state.items.map((i) => i.url).join(' ');
    if (!key || key === durationsFor.current) return;
    durationsFor.current = key;

    let live = true;
    for (const item of state.items) {
      if (item.kind === 'MPD') continue;
      const measure = item.kind === 'MP4' ? Promise.resolve(null) : hlsDuration(item.url);
      void measure
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

  const send = (type: string, url?: string) => {
    if (state.status !== 'ready') return;
    void browser.runtime
      .sendMessage({ type, url, tabId: state.tabId })
      .then(refresh)
      .catch(refresh);
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

  const footer = (
    <footer className="bar">
      <button className="ghost" title="Refresh" onClick={refresh}>
        <Icon path={ICONS.refresh} />
      </button>
      <div className="bar-spacer" />
      <button
        className="ghost"
        title="Open downloads"
        onClick={() => void browser.tabs.create({ url: 'chrome://downloads' })}
      >
        <Icon path={ICONS.folder} />
      </button>
      <button className="ghost" title="Clear list" onClick={() => send('kisskh-clear')}>
        <Icon path={ICONS.trash} />
      </button>
      <button
        className={`ghost${help ? ' on' : ''}`}
        title="Help"
        onClick={() => setHelp((v) => !v)}
      >
        <Icon path={ICONS.help} />
      </button>
    </footer>
  );

  if (state.status === 'loading') {
    return (
      <div className="app">
        <p className="msg">Loading...</p>
        {footer}
      </div>
    );
  }

  if (state.status === 'idle') {
    return (
      <div className="app">
        <p className="msg">{state.message}</p>
        {footer}
      </div>
    );
  }

  const { drama, items, origin } = state;
  const counts = drama ? countEpisodes(drama) : null;

  return (
    <div className="app">
      <header className="head">
        <h1>{drama?.title ?? 'KissKH'}</h1>
        <span className="head-sub">
          {items.length ? `${items.length} captured` : 'nothing captured'}
          {counts ? ` / ${counts.total} episodes` : ''}
        </span>
      </header>

      {help && (
        <p className="help">
          An .m3u8 is a playlist of thousands of segments, not a video file, so
          it cannot be saved with one click. Copy the ffmpeg or yt-dlp command
          and run it in a terminal; it downloads and joins the segments for you.
        </p>
      )}

      {items.length ? (
        <ul className="cards">
          {items.map((item) => (
            <Card
              key={item.url}
              item={item}
              origin={origin}
              thumbnail={drama?.thumbnail}
              onRename={(name) => void rename(item.url, name)}
              onDismiss={() => send('kisskh-dismiss', item.url)}
            />
          ))}
        </ul>
      ) : (
        <p className="msg">
          <strong>No video yet.</strong>
          <br />
          Start playing the episode, then hit refresh.
        </p>
      )}

      {footer}
    </div>
  );
}

export default App;
