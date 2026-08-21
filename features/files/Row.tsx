/** One captured file, and everything that can be done with it. */
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { Menu } from '@base-ui-components/react/menu';
import { PLAYLIST, isSubtitle, metaOf } from '@/features/capture/kind';
import {
  copy,
  ffmpegCommand,
  safeName,
  ytDlpCommand,
} from '@/features/capture/naming';
import type { Item } from '@/features/capture/types';
import { MenuItem, MenuPopup } from '@/features/files/RowMenu';
import { Check, Dots } from '@/features/ui/icons';

export function Row({
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
