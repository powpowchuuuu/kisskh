/** The subtitle languages the site offers, and which of them to keep. */

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
