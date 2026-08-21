/** Which subtitle languages survive the read filter. */
import { Checkbox } from '@base-ui-components/react/checkbox';
import { LANGUAGES } from '@/features/kisskh/languages';
import { Check } from '@/features/ui/icons';
import { Kicker } from '@/features/ui/Kicker';

export function Settings({
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
