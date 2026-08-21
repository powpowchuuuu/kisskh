/** Captures grouped the way the list is read: an episode and its tracks. */
import { useState } from 'react';
import { Collapsible } from '@base-ui-components/react/collapsible';
import { episodeLabel } from '@/features/capture/kind';
import type { Item } from '@/features/capture/types';
import { Row } from '@/features/files/Row';
import { ChevronDown, ChevronRight } from '@/features/ui/icons';

export function Files({
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
    <div className="pt-[6px] pb-[10px]">
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
