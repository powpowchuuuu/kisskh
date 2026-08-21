import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { Tabs } from '@base-ui-components/react/tabs';
import { isSubtitle, resourceKey } from '@/features/capture/kind';
import { load } from '@/features/capture/load';
import { hlsDuration, probe } from '@/features/capture/remote';
import type { Item, State } from '@/features/capture/types';
import { DeleteAll } from '@/features/files/DeleteAll';
import { Files } from '@/features/files/Files';
import { countEpisodes } from '@/features/kisskh/api';
import { DEFAULT_LANGS, LANGS_KEY, LANGUAGES } from '@/features/kisskh/languages';
import {
  META_KEY,
  NAMES_KEY,
  SERVER_KEY,
  type DramaMeta,
  type ServerConfig,
} from '@/features/kisskh/storage';
import { Note } from '@/features/note/Note';
import { buildPayload } from '@/features/server/payload';
import { Server } from '@/features/server/Server';
import { Settings } from '@/features/settings/Settings';
import { Kicker } from '@/features/ui/Kicker';

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
            ) : null}

            {items.length > 0 && (
              <DeleteAll
                count={items.length}
                onConfirm={() => drop(() => false, { type: 'kisskh-clear' })}
              />
            )}

            {items.length === 0 && (
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
