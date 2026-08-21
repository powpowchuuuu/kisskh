/** What gets POSTed to the user's own server. */
import { isSubtitle } from '@/features/capture/kind';
import type { Item } from '@/features/capture/types';
import type { KisskhDrama } from '@/features/kisskh/api';
import type { DramaMeta } from '@/features/kisskh/storage';

/**
 * Everything the extension knows, shaped for a receiving server: when it was
 * sent, where it came from, the drama, then every episode with its videos and
 * its subtitle tracks. Stamped at build time so the preview shows the same
 * instant the request will carry.
 */
export function buildPayload(
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
