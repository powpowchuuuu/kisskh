/** The pasteable listing, and the release name that heads it. */
import { useEffect, useState } from 'react';
import { copy } from '@/features/capture/naming';
import type { Item } from '@/features/capture/types';
import type { DramaMeta } from '@/features/kisskh/storage';
import { buildNote } from '@/features/note/buildNote';
import { Kicker } from '@/features/ui/Kicker';

export function Note({
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
