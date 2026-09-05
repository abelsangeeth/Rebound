import type { Cohort } from '../lib/api';
import { num, pct } from '../lib/api';

/**
 * Recovery by planted cohort.
 *
 * This table is the honest scorecard, and it is only possible because the
 * simulator knows the answer. Two rows carry most of the argument:
 *
 *   salary_cycle  — recoverable, and it must wait for payday
 *   impulse_lost  — NOT recoverable, and it wears a soft-looking decline
 *
 * Both can surface as `authentication_failed`. A rules engine keyed on the
 * error string treats them identically and burns retries on the second one
 * forever. Separating them needs amount, hour and history — which is precisely
 * what the model is for. If the two rows below look different, the model is
 * doing real work.
 */
const NOTES: Record<string, string> = {
  salary_cycle: 'waiting for payday works — but only if you wait long enough',
  issuer_outage: 'short outage; retry soon or switch rail, waiting days is wrong',
  limit_exceeded: 'same amount never clears — the ask has to change shape',
  dead_instrument: 'never recoverable; every attempt here is pure waste',
  flaky_network: 'ambiguous timeouts; must reconcile before any retry',
  impulse_lost: 'looks soft, never converts — the trap a rules engine falls into',
};

export default function Cohorts({ data }: { data: { cohorts: Cohort[] } | null }) {
  const rows = [...(data?.cohorts ?? [])].sort((a, b) => b.n - a.n);

  return (
    <div className="panel">
      <header>
        <h2>Recovery by cohort</h2>
        <p>
          Ground truth planted by the simulator. Cohort is never visible to the policy — it has to
          be inferred from the decline signal.
        </p>
      </header>
      <div className="body flush">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Cohort</th>
                <th></th>
                <th className="num">Failed</th>
                <th className="num">Recovered</th>
                <th className="num">Rate</th>
                <th className="num">Avg attempts</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    no traffic yet
                  </td>
                </tr>
              )}
              {rows.map((c) => (
                <tr key={c.cohort}>
                  <td>
                    <div className="mono" style={{ fontWeight: 500 }}>
                      {c.cohort}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                      {NOTES[c.cohort] ?? ''}
                    </div>
                  </td>
                  <td>
                    <span className={`pill ${c.recoverable ? 'ok' : 'neutral'}`}>
                      {c.recoverable ? 'winnable' : 'dead'}
                    </span>
                  </td>
                  <td className="num">{num(c.n)}</td>
                  <td className="num">{num(c.recovered)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    {pct(c.n ? c.recovered / c.n : 0, 0)}
                  </td>
                  <td className="num">{c.avg_attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
