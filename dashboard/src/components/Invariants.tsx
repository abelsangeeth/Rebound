import type { Invariant } from '../lib/api';

/**
 * Live invariant panel.
 *
 * These are read straight out of a Postgres view that recomputes them from the
 * ledger and attempt tables on every poll. Nothing here is a counter the API
 * remembered to increment — if an invariant were violated, this panel would
 * find out, because it asks the data rather than the application.
 */
export default function Invariants({ data }: { data: { all_ok: boolean; invariants: Invariant[] } | null }) {
  const inv = data?.invariants ?? [];
  const allOk = data?.all_ok ?? true;

  return (
    <div className="panel">
      <header>
        <h2>Invariants</h2>
        <span className={`pill ${allOk ? 'ok' : 'crit'}`}>
          <i className={`dot ${allOk ? 'live' : ''}`} />
          {allOk ? 'all holding' : 'violation'}
        </span>
        <p>
          Recomputed from the ledger on every poll, not tracked incrementally. Try to break one from
          the chaos console below.
        </p>
      </header>
      <div className="body flush">
        <div className="inv">
          {inv.length === 0 && <div className="empty">waiting for the API…</div>}
          {inv.map((i) => (
            <div key={i.name} className={`inv-row ${i.ok ? '' : 'bad'}`}>
              <span
                className="icon s18 mark"
                style={{ color: i.ok ? 'var(--ok)' : 'var(--crit)' }}
                aria-hidden="true"
              >
                {i.ok ? 'check_circle' : 'cancel'}
              </span>
              <div>
                <div className="name">{i.name}</div>
                <div className="stmt">{i.statement}</div>
              </div>
              <span className={`pill ${i.ok ? 'neutral' : 'crit'}`}>
                {i.observed === '0' ? 'clean' : i.observed}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
