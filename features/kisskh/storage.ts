/**
 * Every key the extension writes under, in one place. The popup, the content
 * script and the service worker all reach for these, and two of them used to
 * carry their own copy of the literal.
 */

/** The stream url the page hook last reported, with the episode it belonged to. */
export const VIDEO_KEY = 'kisskh-video';

/** Filenames the user has renamed, keyed by url. */
export const NAMES_KEY = 'kisskh-names';

/** Per-drama details the kisskh api does not carry, keyed by drama id. */
export const META_KEY = 'kisskh-meta';

export interface DramaMeta {
  /** Overrides the api title when it differs from the release name. */
  name?: string;
}

/** Where the listing gets pushed, and the credential it may need. */
export const SERVER_KEY = 'kisskh-server';

export interface ServerConfig {
  /** Endpoint the payload is POSTed to. */
  url?: string;
  /** Sent as an `X-Token` header. Empty when the server is open. */
  token?: string;
  /** ISO timestamp of the last successful push, for the pane to report. */
  lastSentAt?: string;
}
