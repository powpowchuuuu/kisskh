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

/** The stream payload the site's player receives for one episode. */
export interface KisskhSource {
  /** Playlist/manifest url (m3u8) or direct file url (mp4). */
  Video?: string;
  /** Older players used this field name. */
  link?: string;
  /** Lower quality fallback. */
  dataSaver?: string;
}

/** Extracts the stream url from a KisskhSource, if any. */
export function pickVideoUrl(source: KisskhSource | null | undefined): string | null {
  const candidate = source?.Video || source?.link || source?.dataSaver;
  return typeof candidate === 'string' && /^https?:/i.test(candidate) ? candidate : null;
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

/** Reads the episode id from a kisskh URL (?ep=196111). Null when there is none. */
export function getEpisodeId(url: string): string | null {
  try {
    const ep = new URL(url).searchParams.get('ep');
    return ep && /^\d+$/.test(ep) ? ep : null;
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

/** Where the chosen subtitle languages live. */
export const LANGS_KEY = 'kisskh-langs';

export interface Language {
  id: string;
  label: string;
  /**
   * Matches the label the site puts on a track. Short codes are allowed here
   * because a label is a language and nothing else.
   */
  code: RegExp;
  /**
   * Matches a url, where short codes cause false hits -- "id" alone appears in
   * every kisskh query string -- so only the spelled-out names are accepted.
   */
  name: RegExp;
}

/** The languages kisskh offers, in the order it lists them. */
export const LANGUAGES: Language[] = [
  { id: 'en', label: 'English',   code: /(^|[^a-z])(en|eng|english)([^a-z]|$)/i,                 name: /english/i },
  { id: 'km', label: 'Khmer',     code: /(^|[^a-z])(km|khm|khmer|cambodian)([^a-z]|$)/i,         name: /khmer|cambodian/i },
  { id: 'ar', label: 'Arabic',    code: /(^|[^a-z])(ar|ara|arabic)([^a-z]|$)/i,                  name: /arabic/i },
  { id: 'id', label: 'Indonesia', code: /(^|[^a-z])(id|ind|indo|indonesia|indonesian)([^a-z]|$)/i, name: /indonesia/i },
  { id: 'ms', label: 'Malay',     code: /(^|[^a-z])(ms|may|msa|malay|melayu)([^a-z]|$)/i,        name: /malay|melayu/i },
  { id: 'fr', label: 'French',    code: /(^|[^a-z])(fr|fre|fra|french|fran[c\u00e7]ais)([^a-z]|$)/i, name: /french|fran[c\u00e7]ais/i },
];

/** What a fresh install keeps. */
export const DEFAULT_LANGS = ['fr'];

/**
 * True when a track belongs to one of the chosen languages. The label decides
 * when there is one; only then does the url get a look, and with the stricter
 * pattern. A track we cannot name at all is kept: dropping it silently would
 * hide the very thing the user came for.
 */
export function matchesLanguages(
  chosen: readonly string[],
  label: string | null | undefined,
  url: string,
): boolean {
  const wanted = LANGUAGES.filter((lang) => chosen.includes(lang.id));
  if (!wanted.length) return false;
  if (typeof label === 'string' && label.trim() !== '') {
    return wanted.some((lang) => lang.code.test(label));
  }
  const named = LANGUAGES.some((lang) => lang.name.test(url));
  return named ? wanted.some((lang) => lang.name.test(url)) : true;
}
