import type { Rail } from '../lib/api';
import { pct, num } from '../lib/api';

/**
 * Rail health.
 *
 * `rate` is the naive success rate; `wilson` is its 95% lower bound. The gap
 * between them is how much of the rate is real and how much is a small sample
 * flattering itself — routing uses the lower bound, so a rail that went 2-for-2
 * cannot leapfrog one with a thousand attempts behind it.
 *
 * The breaker counts only ISSUER-side errors. A rail full of insufficient-funds
 * declines is working fine; a rail full of issuer_down is not.
 */
export default function Rails({ data }: { data: { rails: Rail[] } | null }) {
  const rails = [...(data?.rails ?? [])].sort((a, b) => b.wilson - a.wilson);

  return (
    <div className="panel">
      <header>
        <h2>Rail health</h2>
        <p>Last 6 hours of virtual time. Routing ranks on the Wilson lower bound, not the raw rate.</p>
      </header>
      <div className="body flush">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Rail</th>
                <th className="num">Attempts</th>
                <th className="num">Raw rate</th>
                <th className="num">Wilson 95%</th>
                <th className="num">Issuer errors</th>
                <th>Breaker</th>
              </tr>
            </thead>
            <tbody>
              {rails.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    no traffic yet
                  </td>
                </tr>
              )}
              {rails.map((r) => (
                <tr key={r.rail}>
                  <td className="mono">{r.rail}</td>
                  <td className="num">{num(r.attempts)}</td>
                  <td className="num">{pct(r.rate)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    {pct(r.wilson)}
                  </td>
                  <td className="num" style={{ color: r.issuer_errors ? 'var(--warn)' : undefined }}>
                    {num(r.issuer_errors)}
                  </td>
                  <td>
                    <span className={`pill ${r.breaker_open ? 'crit' : 'ok'}`}>
                      {r.breaker_open ? 'open' : 'closed'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
