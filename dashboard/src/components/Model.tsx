import { usePoll } from '../lib/api';

interface ModelInfo {
  metrics: {
    auc: number;
    brier_raw: number;
    brier_calibrated: number;
    base_rate: number;
    n_samples: number;
    trees: number;
    reliability: { bucket: string; n: number; predicted: number; observed: number }[];
  } | null;
  importance: { feature: string; gain: number }[];
}

/**
 * Model card.
 *
 * Shows calibration, not just AUC. The policy multiplies this model's output
 * by a rupee amount and compares it to a cost, so a model that ranks well but
 * is over-confident would authorise retries that lose money on every one. The
 * reliability table is the check that matters: predicted should track observed
 * down the column.
 */
export default function Model() {
  const { data } = usePoll<ModelInfo>('/api/model', 15000);
  const m = data?.metrics;
  const imp = data?.importance ?? [];
  const maxGain = Math.max(1, ...imp.map((i) => i.gain));

  return (
    <div className="panel">
      <header>
        <h2>Model</h2>
        {m ? (
          <span className="pill ok">
            <i className="dot" />
            trained
          </span>
        ) : (
          <span className="pill warn">using cold-start prior</span>
        )}
        <p>
          Gradient-boosted trees over the decline signal, timing and rail. Reports calibration
          because the output gets spent, not just ranked.
        </p>
      </header>
      <div className="body">
        {!m && (
          <div className="empty">
            No trained model yet. Run <code className="mono">npm run seed</code> then{' '}
            <code className="mono">python -m app.train</code>.
          </div>
        )}
        {m && (
          <>
            <div className="tiles">
              <div className="tile">
                <div className="k">AUC</div>
                <div className="v">{m.auc}</div>
              </div>
              <div className="tile">
                <div className="k">Brier</div>
                <div className="v">{m.brier_calibrated}</div>
              </div>
              <div className="tile">
                <div className="k">Base rate</div>
                <div className="v">{(m.base_rate * 100).toFixed(1)}%</div>
              </div>
            </div>
            <p style={{ margin: '-10px 0 18px', fontSize: 12.3, color: 'var(--ink-3)' }}>
              Ranking quality, calibration error (lower is better), and the positive rate across{' '}
              {m.n_samples.toLocaleString('en-IN')} samples over {m.trees} trees.
            </p>

            <h3
              style={{
                fontFamily: 'var(--f-display)',
                fontSize: 13,
                margin: '0 0 11px',
              }}
            >
              What the model leans on
            </h3>
            <div style={{ display: 'grid', gap: 7, marginBottom: 20 }}>
              {imp.slice(0, 9).map((i) => (
                <div className="shap-bar" key={i.feature}>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {i.feature}
                  </span>
                  <div className="track">
                    <div
                      className="seg pos"
                      style={{ left: 0, width: `${(i.gain / maxGain) * 100}%` }}
                    />
                  </div>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                    {Math.round(i.gain).toLocaleString('en-IN')}
                  </span>
                </div>
              ))}
            </div>

            <h3 style={{ fontFamily: 'var(--f-display)', fontSize: 13, margin: '0 0 9px' }}>
              Calibration
            </h3>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Predicted band</th>
                    <th className="num">n</th>
                    <th className="num">Says</th>
                    <th className="num">Actually</th>
                  </tr>
                </thead>
                <tbody>
                  {(m.reliability ?? []).map((r) => {
                    const off = Math.abs(r.predicted - r.observed);
                    return (
                      <tr key={r.bucket}>
                        <td className="mono">{r.bucket}</td>
                        <td className="num">{r.n.toLocaleString('en-IN')}</td>
                        <td className="num">{(r.predicted * 100).toFixed(1)}%</td>
                        <td
                          className="num"
                          style={{
                            fontWeight: 600,
                            color: off > 0.1 ? 'var(--warn)' : 'var(--ok)',
                          }}
                        >
                          {(r.observed * 100).toFixed(1)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
