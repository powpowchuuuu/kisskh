/** The shape of the site's DramaList API, and the call that reads it. */

export interface KisskhEpisode {
  id: number;
  number: number;
  sub: number;
}

export interface KisskhDrama {
  id: number;
  title: string;
  type: string;
  status: string;
  country: string;
  episodesCount: number;
  episodes: KisskhEpisode[];
  /** Poster url; the API omits it on some entries. */
  thumbnail?: string;
}

/**
 * Calls the site's own DramaList API.
 * `origin` lets the popup target the tab's domain while the content script
 * stays same-origin.
 */
export async function fetchDrama(
  origin: string,
  id: string,
): Promise<KisskhDrama> {
  const res = await fetch(`${origin}/api/DramaList/Drama/${id}?isq=false`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`API responded ${res.status}`);
  return res.json();
}

/**
 * episodesCount is the announced total; episodes[] is what is actually
 * listed. They disagree on shows that are still airing.
 */
export function countEpisodes(drama: KisskhDrama) {
  const listed = drama.episodes?.length ?? 0;
  return { total: drama.episodesCount ?? listed, listed };
}
