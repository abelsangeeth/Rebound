import { useState } from 'react';
import { post, rupees, num } from '../lib/api';

/**
 * Counterfactual A/B.
 *
 * The single most important panel here. Every other number on this dashboard
 * says how Rebound did; this one says how much of that was Rebound rather
 * than the traffic. The same seeded orders -- same cohorts, same unlock times,
 * same PRNG stream -- are replayed through four policies, so the comparison is
 * causal rather than a before/after on different customers.
 *
 * Encoding note: this is NOT four categorical series. It is one policy against
 * three comparators, so the bars use emphasis (accent vs neutral), not four
 * hues. Every bar is also directly labelled, so identity never rests on colour
 * alone, and the table underneath is the full table view.
 */
interface ArmResult {
  arm: string;
  label: string;
  orders: number;
  recovered: number;
  recovered_value: number;
  ceiling_value: number;
  capture_of_ceiling: number;
  retries: number;
  wasted_retries: number;
  net_value: number;
}

interface ExperimentResult {
  n: number;
  seed: number;
  took_ms: number;
  results: ArmResult[];
  delta: {
    vs: string;
    extra_recovered_paise: number;
    extra_recovered_pct: number;
    capture_points: number;
    retries_saved: number;
    net_value_delta: number;
  };
}

export default function Experiment() {
  const [data, setData] = useState<ExperimentResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(2000);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      setData(await post<ExperimentResult>('/api/experiment', { n, seed: 20260902 }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const max = Math.max(0.0001, ...(data?.results ?? []).map((r) => r.capture_of_ceiling));

  return (
    <div className="panel">
      <header>
        <h2>Counterfactual: does the model actually earn its place?</h2>
        <div style={{ display: 'flex', gap: 9, alignItems: 'center', marginLeft: 'auto' }}>
          <select value={n} onChange={(e) => setN(Number(e.target.value))} disabled={busy}>
            <option value={500}>500 orders</option>
            <option value={2000}>2,000 orders</option>
            <option value={4000}>4,000 orders</option>
          </select>
          <button className="primary" onClick={run} disabled={busy}>
            {busy ? 'replaying…' : 'Run experiment'}
          </button>
        </div>
        <p>
          The same seeded orders replayed through four policies. Because the simulated network is
          deterministic, this is a true counterfactual — the identical customer is put through every
          policy, which production traffic can never tell you.
        </p>
      </header>

      <div className="body">
        {!data && !busy && (
          <div className="empty">
            Press <strong>Run experiment</strong>. Nothing is written to the database — it replays
            in memory and leaves the live metrics untouched.
          </div>
        )}
        {err && <div className="verdict fail">{err}</div>}

        {data && (
          <>
            <div className="chart-head">
              <span>Share of the genuinely recoverable money captured</span>
              <span className="mono">
                {num(data.n)} orders · seed {data.seed} · {data.took_ms}ms
              </span>
            </div>

            <div className="bars">
              {data.results.map((r) => {
                const isOurs = r.arm === 'rebound';
                return (
                  <div className="bar-row" key={r.arm}>
                    <div className="bar-label">
                      {r.label}
                      {isOurs && <span className="pill accent">ours</span>}
                    </div>
                    <div className="bar-track">
                      <div
                        className={`bar-fill${isOurs ? ' ours' : ''}`}
                        style={{ width: `${(r.capture_of_ceiling / max) * 100}%` }}
                        title={`${r.label}\ncaptured ₹${rupees(r.recovered_value)} of ₹${rupees(
                          r.ceiling_value,
                        )}\n${r.retries} retries, ${r.wasted_retries} of them wasted`}
                      />
                    </div>
                    <div className="bar-value mono">
                      {(r.capture_of_ceiling * 100).toFixed(1)}%
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="delta-note">
              Against the strongest baseline (<span className="mono">{data.delta.vs}</span>), Rebound
              recovered <strong>₹{rupees(data.delta.extra_recovered_paise)} more</strong> (
              {data.delta.extra_recovered_pct > 0 ? '+' : ''}
              {data.delta.extra_recovered_pct}%) using{' '}
              <strong>{num(data.delta.retries_saved)} fewer retries</strong>. More money, fewer
              messages — the two usually trade off, and here they do not.
            </div>

            <div className="scroll" style={{ marginTop: 16 }}>
              <table>
                <thead>
                  <tr>
                    <th>Policy</th>
                    <th className="num">Captured</th>
                    <th className="num">Recovered</th>
                    <th className="num">Retries</th>
                    <th className="num">Wasted</th>
                    <th className="num">Net of cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r) => (
                    <tr key={r.arm}>
                      <td>
                        <span className="mono" style={{ fontSize: 12 }}>
                          {r.arm}
                        </span>
                      </td>
                      <td className="num" style={{ fontWeight: r.arm === 'rebound' ? 600 : 400 }}>
                        {(r.capture_of_ceiling * 100).toFixed(1)}%
                      </td>
                      <td className="num">₹{rupees(r.recovered_value)}</td>
                      <td className="num">{num(r.retries)}</td>
                      <td className="num">{num(r.wasted_retries)}</td>
                      <td className="num">₹{rupees(r.net_value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="footnote">
              The two rules arms already skip hard declines, so all three share the same wasted-retry
              floor. The gap above it is timing and rail choice alone — which is the claim being
              tested, isolated from the guardrail.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
