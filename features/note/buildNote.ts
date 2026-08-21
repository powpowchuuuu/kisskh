/** The pasteable listing behind the Note tab. */
import { episodeLabel, isSubtitle } from '@/features/capture/kind';
import type { Item } from '@/features/capture/types';
import type { DramaMeta } from '@/features/kisskh/storage';

/**
 * A plain-text listing meant to be pasted elsewhere: the release name on top,
 * then each episode followed by the subtitles that belong to it, every line
 * carrying the url it points at.
 */
export function buildNote(title: string, meta: DramaMeta, items: readonly Item[]): string {
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
