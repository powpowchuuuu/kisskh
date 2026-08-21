interface KisskhEpisode {
  id: number;
  number: number;
  sub: number;
}

interface KisskhDrama {
  id: number;
  title: string;
  type: string;
  status: string;
  episodesCount: number;
  episodes: KisskhEpisode[];
}

const BADGE_ID = 'kisskh-ext-badge';

/** Reads the drama id from the current URL (?id=549). */
function getDramaId(): string | null {
  const id = new URLSearchParams(location.search).get('id');
  return id && /^\d+$/.test(id) ? id : null;
}

async function fetchDrama(id: string): Promise<KisskhDrama> {
  const res = await fetch(`/api/DramaList/Drama/${id}?isq=false`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`API responded ${res.status}`);
  return res.json();
}

function renderBadge(text: string) {
  let badge = document.getElementById(BADGE_ID);
  if (!badge) {
    badge = document.createElement('div');
    badge.id = BADGE_ID;
    badge.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'right:16px',
      'z-index:2147483647',
      'padding:8px 12px',
      'border-radius:8px',
      'background:rgba(17,17,17,.92)',
      'color:#fff',
      'font:13px/1.4 system-ui,sans-serif',
      'box-shadow:0 2px 10px rgba(0,0,0,.4)',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(badge);
  }
  badge.textContent = text;
}

function removeBadge() {
  document.getElementById(BADGE_ID)?.remove();
}

async function run() {
  const id = getDramaId();
  if (!id) {
    removeBadge();
    return;
  }

  try {
    const drama = await fetchDrama(id);
    // episodesCount is the announced total; episodes[] is what is actually listed.
    const listed = drama.episodes?.length ?? 0;
    const total = drama.episodesCount ?? listed;

    console.log('[kisskh]', {
      id: drama.id,
      title: drama.title,
      episodesCount: total,
      episodesListed: listed,
    });

    const suffix = listed && listed !== total ? ` (${listed} listed)` : '';
    renderBadge(`${drama.title} — ${total} episodes${suffix}`);
  } catch (err) {
    console.error('[kisskh] failed to fetch drama', id, err);
    renderBadge('kisskh: failed to load episode count');
  }
}

export default defineContentScript({
  matches: [
    '*://kisskh.co/*',
    '*://*.kisskh.co/*',
    '*://kisskh.me/*',
    '*://*.kisskh.me/*',
  ],
  runAt: 'document_idle',
  main(ctx) {
    run();
    // kisskh is a SPA: the id changes without a full page load.
    ctx.addEventListener(window, 'wxt:locationchange', () => run());
  },
});
