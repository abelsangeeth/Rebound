import { useEffect, useState } from 'react';
import { get, post, rupees, delay, pct, num } from '../lib/api';

/**
 * One order, end to end.
 *
 * The "why did you charge my customer again?" answer, which is the question a
 * merchant actually asks. Attempts, the decision after each one with the
 * reasons recorded at the time, the SHAP attribution behind the next move, and
 * the money that moved. Nothing here is reconstructed after the fact -- every
 * row was written when the decision was made.
 */
interface Detail {
  order: any;
  attempts: any[];
  decisions: any[];
  ledger: any[];
  nudges: any[];
}

const STATUS_CLASS: Record<string, string> = {
  succeeded: 'win',
  failed: 'bad',
  unknown: 'amb',
  pending: '',
};

export default function OrderDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [why, setWhy] = useState<any>(null);
  const [nudge, setNudge] = useState<any>(null);
  const [lang, setLang] = useState('hinglish');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<Detail>(`/api/orders/${id}`).then(setD).catch(() => {});
    get<any>(`/api/orders/${id}/why`).then(setWhy).catch(() => {});
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function writeNudge() {
    setBusy(true);
    try {
      setNudge(await post(`/api/nudge/${id}`, { language: lang }));
    } finally {
      setBusy(false);
    }
  }

  const o = d?.order;
  const maxShap = Math.max(0.001, ...((why?.shap ?? []) as any[]).map((s) => Math.abs(s.contribution)));

  return (
    <div className="drawer" onClick={onClose}>
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{o ? `₹${rupees(o.amount_paise)}` : 'Loading…'}</h3>
          {o && (
            <>
              <span className={`pill ${o.status === 'paid' ? 'ok' : o.status === 'abandoned' ? 'neutral' : 'accent'}`}>
                {o.status}
              </span>
              <span className="pill neutral">{o.sim_cohort}</span>
              <span className={`pill ${o.sim_recoverable ? 'ok' : 'crit'}`}>
                {o.sim_recoverable ? 'was winnable' : 'never winnable'}
              </span>
            </>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>

        {d && (
          <div className="drawer-body">
            <div>
              <h4>What happened</h4>
              <div className="timeline">
                {d.attempts.map((a) => {
                  const dec = d.decisions.find((x) => x.after_attempt === a.attempt_no);
                  return (
                    <div className="tl-item" key={a.id}>
                      <div className={`tl-dot ${STATUS_CLASS[a.status] ?? ''}`}>{a.attempt_no}</div>
                      <div className="tl-body">
                        <div className="tl-head">
                          <span className="mono" style={{ fontWeight: 600 }}>
                            {a.rail}
                          </span>
                          <span
                            className={`pill ${
                              a.status === 'succeeded' ? 'ok' : a.status === 'unknown' ? 'warn' : 'crit'
                            }`}
                          >
                            {a.status}
                          </span>
                          {a.error_reason && (
                            <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
                              {a.error_reason}
                            </span>
                          )}
                          {a.decline_class && (
                            <span className="pill neutral">{a.decline_class}</span>
                          )}
                        </div>
                        {dec && (
                          <ul className="reasons">
                            {(dec.reasons ?? []).map((r: string, i: number) => (
                              <li key={i}>{r}</li>
                            ))}
                            {dec.should_retry && (
                              <li>
                                → scheduled {dec.rail} in {delay(dec.delay_seconds)}
                                {dec.p_success ? ` (p=${pct(dec.p_success, 0)})` : ''}
                              </li>
                            )}
                          </ul>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {why?.shap?.length > 0 && (
              <div>
                <h4>
                  Why the model scored it that way{' '}
                  <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-3)', fontWeight: 400 }}>
                    p={pct(why.p_success, 1)}
                  </span>
                </h4>
                <p style={{ margin: '0 0 11px', fontSize: 12.4, color: 'var(--ink-3)' }}>
                  Exact SHAP contributions from the trees — green pushed the probability up, red
                  pushed it down.
                </p>
                <div style={{ display: 'grid', gap: 7 }}>
                  {why.shap.map((s: any) => {
                    const w = (Math.abs(s.contribution) / maxShap) * 50;
                    const pos = s.contribution >= 0;
                    return (
                      <div className="shap-bar" key={s.feature}>
                        <span className="mono" style={{ fontSize: 11.8 }}>
                          {s.feature}
                        </span>
                        <div className="track">
                          <div
                            className={`seg ${pos ? 'pos' : 'neg'}`}
                            style={
                              pos
                                ? { left: '50%', width: `${w}%` }
                                : { right: '50%', width: `${w}%` }
                            }
                          />
                        </div>
                        <span
                          className="mono"
                          style={{ fontSize: 11, color: pos ? 'var(--ok)' : 'var(--crit)' }}
                        >
                          {s.contribution > 0 ? '+' : ''}
                          {s.contribution.toFixed(2)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <h4>Message the customer</h4>
              <p style={{ margin: '0 0 11px', fontSize: 12.4, color: 'var(--ink-3)' }}>
                Claude writes the copy. It receives a decision already made and turns it into a
                sentence — it cannot start, schedule or change a payment.
              </p>
              <div style={{ display: 'flex', gap: 9, marginBottom: 11 }}>
                <select value={lang} onChange={(e) => setLang(e.target.value)}>
                  <option value="hinglish">Hinglish</option>
                  <option value="en">English</option>
                  <option value="hi">Hindi</option>
                </select>
                <button onClick={writeNudge} disabled={busy}>
                  {busy ? 'writing…' : 'Draft message'}
                </button>
              </div>
              {nudge && (
                <div className="verdict">
                  <p style={{ margin: 0, color: 'var(--ink)', fontSize: 13.5 }}>{nudge.body}</p>
                  <p style={{ margin: '9px 0 0', fontSize: 11.6, color: 'var(--ink-3)' }}>
                    {nudge.generator}
                  </p>
                </div>
              )}
              {d.nudges.length > 0 && (
                <div style={{ marginTop: 11 }}>
                  {d.nudges.map((n) => (
                    <div key={n.id} style={{ fontSize: 12.6, color: 'var(--ink-2)', marginBottom: 6 }}>
                      <span className="pill neutral">{n.language}</span> {n.body}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {d.ledger.length > 0 && (
              <div>
                <h4>Money</h4>
                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th>Dir</th>
                        <th className="num">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.ledger.map((l) => (
                        <tr key={l.id}>
                          <td className="mono" style={{ fontSize: 12 }}>
                            {l.account}
                          </td>
                          <td>
                            <span className="pill neutral">{l.direction}</span>
                          </td>
                          <td className="num">₹{rupees(l.amount_paise)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="footnote">
                  Debits and credits in each group sum to zero — checked continuously by the
                  <span className="mono"> every_group_balances </span> invariant, not asserted here.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
