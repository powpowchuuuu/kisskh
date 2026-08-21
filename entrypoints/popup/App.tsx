import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  countEpisodes,
  fetchDrama,
  getDramaId,
  isKisskhUrl,
  type KisskhDrama,
} from '@/utils/kisskh';
import './App.css';

type State =
  | { status: 'loading' }
  | { status: 'idle'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; drama: KisskhDrama };

async function load(): Promise<State> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url;

  if (!url || !isKisskhUrl(url)) {
    return { status: 'idle', message: 'Open a KissKH page to see its episodes.' };
  }

  const id = getDramaId(url);
  if (!id) {
    return { status: 'idle', message: 'This KissKH page has no drama id in its URL.' };
  }

  try {
    const drama = await fetchDrama(new URL(url).origin, id);
    return { status: 'ready', drama };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function App() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    load().then(setState);
  }, []);

  if (state.status === 'loading') return <p className="msg">Loading...</p>;
  if (state.status === 'idle') return <p className="msg">{state.message}</p>;
  if (state.status === 'error')
    return <p className="msg error">Could not reach the KissKH API: {state.message}</p>;

  const { drama } = state;
  const { total, listed } = countEpisodes(drama);

  return (
    <div className="drama">
      <h1>{drama.title}</h1>

      <div className="count">
        <strong>{total}</strong>
        <span>episodes</span>
      </div>

      {listed !== total && (
        <p className="note">{listed} currently listed on the page.</p>
      )}

      <dl className="meta">
        <dt>Id</dt>
        <dd>{drama.id}</dd>
        <dt>Type</dt>
        <dd>{drama.type}</dd>
        <dt>Status</dt>
        <dd>{drama.status}</dd>
        <dt>Country</dt>
        <dd>{drama.country}</dd>
      </dl>
    </div>
  );
}

export default App;
