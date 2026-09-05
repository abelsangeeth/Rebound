import { useState } from 'react';
import { post } from '../lib/api';

/**
 * Chaos console.
 *
 * Each button attempts a specific, real failure mode against the live system
 * and prints what actually happened. Nothing here is staged: the duplicate
 * webhook is a genuine signed replay through the real handler, and the double
 * charge is two concurrent writes racing at the same unique constraint.
 */
const ATTACKS = [
  {
    id: 'duplicate-webhook',
    title: 'Replay a webhook',
    blurb: 'Redeliver the same signed payment.captured event 5 times, exactly as Razorpay does when an ack is lost.',
    body: { times: 5 },
  },
  {
    id: 'forged-webhook',
    title: 'Forge a signature',
    blurb: 'Post a payment.captured event with an invalid HMAC and see how far into the system it gets.',
  },
  {
    id: 'double-retry',
    title: 'Fire a retry twice',
    blurb: 'Two workers claim the same retry token at the same instant and both try to charge.',
  },
  {
    id: 'ghost-timeout',
    title: 'Charge, then time out',
    blurb: 'The issuer takes the money but the response never arrives. Then something tries to retry it.',
  },
  {
    id: 'retry-hard-decline',
    title: 'Retry a dead card',
    blurb: 'Send an expired or blocked instrument into the policy and see whether it wastes an attempt.',
  },
  {
    id: 'unbalanced-ledger',
    title: 'Unbalance the ledger',
    blurb: 'Try to post a double-entry group whose debits do not equal its credits.',
  },
];

export default function Chaos({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [label, setLabel] = useState<string>('');

  async function run(a: (typeof ATTACKS)[number]) {
    setBusy(a.id);
    setResult(null);
    try {
      const r = await post<any>(`/api/chaos/${a.id}`, a.body ?? {});
      setResult(r);
      setLabel(a.title);
    } catch (e) {
      // A request that never got a response means the connection is broken,
      // not that a guarantee is. Rendering it as a red FAILED verdict would
      // claim the ledger lost a test it was never asked to take.
      setResult({ unreachable: true, error: (e as Error).message });
      setLabel(a.title);
    } finally {
      setBusy(null);
      onDone();
    }
  }

  const unreachable = result?.unreachable === true;
  const held = !unreachable && result?.all_ok !== false && result?.ok !== false;
  const tone = unreachable ? 'warn' : held ? 'pass' : 'fail';
  const colour = unreachable ? 'var(--warn)' : held ? 'var(--ok)' : 'var(--crit)';

  return (
    <div className="panel">
      <header>
        <h2>Chaos console</h2>
        <p>
          Every button below tries to break a specific guarantee against the running system. The
          verdict is computed from the database afterwards, not asserted by the endpoint.
        </p>
      </header>
      <div className="body">
        <div className="chaos-grid">
          {ATTACKS.map((a) => (
            <button
              key={a.id}
              className="chaos-btn"
              disabled={busy !== null}
              onClick={() => run(a)}
            >
              <strong>{busy === a.id ? 'running…' : a.title}</strong>
              <span>{a.blurb}</span>
            </button>
          ))}
        </div>

        {result && (
          <div className={`verdict ${tone}`}>
            <h4>
              <span className="icon s18" style={{ color: colour }} aria-hidden="true">
                {unreachable ? 'cloud_off' : held ? 'verified' : 'gpp_bad'}
              </span>
              {label} — {unreachable ? 'not run' : held ? 'held' : 'FAILED'}
            </h4>
            {unreachable && (
              <p>
                The browser could not reach the API, so nothing was tested and this is
                not a verdict. Check that both the dashboard dev server and the API on
                port 3000 are still running, then reload the page.
              </p>
            )}
            {result.what && <p>{result.what}</p>}
            {result.verdict && (
              <p style={{ color: colour, fontWeight: 500 }}>
                {result.verdict}
              </p>
            )}
            {result.reason && <p>{result.reason}</p>}
            <pre>{JSON.stringify(stripInvariants(result), null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

/** The invariant list is already rendered in its own panel; repeating the whole
 *  thing inside the JSON dump just buries the interesting part. */
function stripInvariants(r: any) {
  const { invariants, what, verdict, ...rest } = r ?? {};
  return rest;
}
