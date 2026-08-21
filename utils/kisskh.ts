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
}

/** Domains the extension is allowed to talk to. */
const KISSKH_HOST = /(^|\.)kisskh\.(co|me)$/i;

export function isKisskhUrl(url: string): boolean {
  try {
    return KISSKH_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Reads the drama id from a kisskh URL (?id=549). Null when there is none. */
export function getDramaId(url: string): string | null {
  try {
    const id = new URL(url).searchParams.get('id');
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
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
