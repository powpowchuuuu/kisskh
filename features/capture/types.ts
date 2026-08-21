/** What the extension has captured, as the popup sees it. */
import type { KisskhDrama } from '@/features/kisskh/api';

export type Kind = 'M3U8' | 'MPD' | 'MP4' | 'VIDEO' | 'SRT' | 'VTT' | 'SUB';

/** One captured url as the background hands it over. */
export interface Entry {
  url: string;
  ep: string | null;
  /** How the background classified it; the url alone is not always enough. */
  kind?: 'video' | 'sub';
  /** Language of a subtitle track, when the page told us. */
  label?: string;
}

/** Not an Entry: `kind` narrows from the background's two-way split to the
 *  format actually shown on the card. */
export interface Item {
  url: string;
  ep: string | null;
  kind: Kind;
  /** Language of a subtitle track; what tells two tracks apart. */
  label?: string;
  /** Episode number this url came from, not the one the tab is showing. */
  episode: number | null;
  /** Editable, defaults to "<Drama> Episode <n> kisskh.mp4". */
  name: string;
  /** Seconds, read from the playlist. Null while loading or unavailable. */
  duration: number | null;
}

export interface Ready {
  status: 'ready';
  drama: KisskhDrama | null;
  /** Why the drama could not be read, when it could not. */
  dramaError?: string;
  items: Item[];
  tabId: number | undefined;
  origin: string;
}

export type State =
  | { status: 'loading' }
  | { status: 'idle'; message: string }
  | Ready;
