/** Pushing the listing to a server or NAS the user owns. */
import { useState } from 'react';
import { browser } from 'wxt/browser';
import type { ServerConfig } from '@/features/kisskh/storage';
import { Kicker } from '@/features/ui/Kicker';

export function Server({
  config,
  onChange,
  makePayload,
}: {
  config: ServerConfig;
  onChange: (patch: ServerConfig) => void;
  /** Called again at send time: the payload carries the instant it left. */
  makePayload: () => unknown;
}) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const preview = JSON.stringify(makePayload(), null, 2);

  const send = async () => {
    const url = config.url?.trim();
    if (!url) {
      setResult({ ok: false, text: 'Enter a URL first.' });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const reply = (await browser.runtime.sendMessage({
        type: 'kisskh-push',
        url,
        token: config.token,
        payload: makePayload(),
      })) as { ok: boolean; status: number; body: string } | undefined;

      if (reply?.ok) {
        const at = new Date();
        onChange({ lastSentAt: at.toISOString() });
        setResult({ ok: true, text: `Sent on ${at.toLocaleString('en-GB')}` });
      } else if (reply?.status) {
        setResult({
          ok: false,
          text: `Refused · HTTP ${reply.status}${reply.body ? ` · ${reply.body}` : ''}`,
        });
      } else {
        setResult({ ok: false, text: `Unreachable · ${reply?.body ?? 'no response'}` });
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-[10px] p-[14px]">
      <div>
        <label htmlFor="server-url" className="mb-1 block">
          <Kicker>Server or NAS URL</Kicker>
        </label>
        <input
          id="server-url"
          className="input min-h-[30px] text-[12.5px]"
          value={config.url ?? ''}
          placeholder="https://nas.local:8080/kisskh"
          onChange={(e) => onChange({ url: e.target.value })}
        />
      </div>

      <div>
        <label htmlFor="server-token" className="mb-1 block">
          <Kicker>Auth token</Kicker>
        </label>
        <input
          id="server-token"
          type="password"
          className="input min-h-[30px] text-[12.5px]"
          value={config.token ?? ''}
          placeholder="leave empty if the server needs none"
          onChange={(e) => onChange({ token: e.target.value })}
        />
        <div className="mt-[3px] text-[11px] text-neutral-700">
          Sent as an <code>X-Token</code> header.
        </div>
      </div>

      <div>
        <div className="mb-1">
          <Kicker>Payload · POST JSON · stamped when sent</Kicker>
        </div>
        <pre className="m-0 max-h-[180px] overflow-auto rounded-md bg-surface px-[10px] py-[9px] font-mono text-[10.5px] leading-[1.7] whitespace-pre text-neutral-800">
          {preview}
        </pre>
      </div>

      {result && (
        <div
          className={`text-[11.5px] ${result.ok ? 'text-accent-700' : 'text-flag-700'}`}
        >
          {result.text}
        </div>
      )}

      {!result && config.lastSentAt && (
        <div className="text-[11.5px] text-neutral-700">
          Last sent on {new Date(config.lastSentAt).toLocaleString('en-GB')}
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={sending}
        onClick={() => void send()}
      >
        {sending ? 'Sending…' : 'Send to server'}
      </button>
    </div>
  );
}
