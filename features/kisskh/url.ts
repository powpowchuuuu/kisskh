/** Reading what an episode page's address already tells us. */

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
