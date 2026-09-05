import type { Decision } from '../lib/api';
import { rupees, pct, delay } from '../lib/api';

/**
 * Live decision feed.
 *
 * Every row is a decision the policy actually made, with the reasons it
 * recorded at the time. A merchant asking "why did you retry that?" gets this,
 * not a shrug — which is the difference between a model you can deploy against
 * real money and one you cannot.
 */
export default function Decisions({ data }: { data: { decisions: Decision[] } | null }) {
  const rows = data?.decisions ?? [];

  return (
    <div className="panel">
      <header>
        <h2>Decisions</h2>
        <p>Newest first. Every retry and every stand-down, with its stated reasoning.</p>
      </header>
      <div className="body flush">
        <div className="feed">
          {rows.length === 0 && <div className="empty">no decisions yet — start the simulator</div>}
          {rows.map((d) => (
            <div className="feed-item" key={d.id}>
              <div className="feed-head">
                <span className={`pill ${d.should_retry ? 'accent' : 'neutral'}`}>
                  {d.should_retry ? `retry ${d.rail}` : 'stand down'}
                </span>
                <span className="amt">₹{rupees(d.amount_paise)}</span>
                {d.should_retry && (
                  <span className="pill neutral">in {delay(d.delay_seconds)}</span>
                )}
                {d.p_success != null && d.p_success > 0 && (
                  <span className="pill neutral">p={pct(d.p_success, 0)}</span>
                )}
                <span className={`pill ${d.policy === 'guardrail' ? 'warn' : 'neutral'}`}>
                  {d.policy}
                </span>
                <span style={{ flex: 1 }} />
                <span className="pill neutral">{d.sim_cohort}</span>
              </div>
              <ul className="reasons">
                {(d.reasons ?? []).map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
