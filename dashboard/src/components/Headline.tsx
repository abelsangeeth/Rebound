import type { Metrics } from '../lib/api';
import { rupees, pct, num } from '../lib/api';

/**
 * The summary, before any detail.
 *
 * `capture_of_ceiling` is the number that actually matters and the one you
 * cannot compute on production traffic: recovered value over the value of
 * everything that was genuinely recoverable. A plain "recovery rate" can be
 * inflated by retrying more; this cannot, because the denominator is fixed by
 * the ground truth the simulator planted.
 *
 * Icons are decorative reinforcement only -- every one sits beside a text
 * label, so the panel reads identically if the icon font never loads.
 */
export default function Headline({ m }: { m: Metrics | null }) {
  if (!m) return null;

  // Retries only. A first attempt on a dead card is discovery, not waste.
  const waste = m.total_retries ? m.wasted_retries / m.total_retries : 0;
  const missed = Math.max(0, m.ceiling_value - m.recovered_value);
  const captured = Math.min(100, m.capture_of_ceiling * 100);

  return (
    <>
      <div className="metrics">
        <div className="metric hero">
          <div className="label">Captured of recoverable</div>
          <div className="value">{pct(m.capture_of_ceiling)}</div>
          <div className="sub">
            ₹{rupees(m.recovered_value)} of a ₹{rupees(m.ceiling_value)} true ceiling
          </div>
          <span className="icon fill watermark" aria-hidden="true">
            trending_up
          </span>
        </div>

        <div className="metric">
          <div className="head">
            <div className="label">Recovered</div>
            <span className="icon s16" aria-hidden="true">
              check_circle
            </span>
          </div>
          <div className="value">₹{rupees(m.recovered_value)}</div>
          <div className="sub">
            {num(m.recovered)} of {num(m.at_risk)} orders that needed recovery
          </div>
        </div>

        <div className="metric">
          <div className="head">
            <div className="label">Still on the table</div>
            <span className="icon s16" aria-hidden="true">
              savings
            </span>
          </div>
          <div className="value">₹{rupees(missed)}</div>
          <div className="sub">recoverable value not yet captured</div>
        </div>

        <div className="metric">
          <div className="head">
            <div className="label">Wasted retries</div>
            <span className={`icon s16${waste > 0.3 ? ' crit' : ''}`} aria-hidden="true">
              {waste > 0.3 ? 'error' : 'filter_alt'}
            </span>
          </div>
          <div className="value">{pct(waste)}</div>
          <div className="sub">
            {num(m.wasted_retries)} of {num(m.total_retries)} retries chased dead instruments
          </div>
        </div>

        <div className="metric">
          <div className="head">
            <div className="label">Ledger</div>
            <span className="icon s16" aria-hidden="true">
              account_balance_wallet
            </span>
          </div>
          <div className="value">₹{rupees(m.ledger?.payable)}</div>
          <div className="sub">
            {num(m.ledger?.groups)} balanced entries · ₹{rupees(m.ledger?.fees)} fees
          </div>
        </div>

        <div className="metric">
          <div className="head">
            <div className="label">Queue</div>
            <span className="icon s16" aria-hidden="true">
              pending
            </span>
          </div>
          <div className="value">{num(m.worker?.queued)}</div>
          <div className="sub">
            {num(m.worker?.retries)} retries · {num(m.worker?.reconciles)} reconciles
            {m.worker?.blocked > 0 && ` · ${num(m.worker.blocked)} blocked`}
          </div>
        </div>
      </div>

      <div className="panel">
        <header>
          <h2>Recovery against the true ceiling</h2>
          <p>
            The hatched section is money that was genuinely winnable and has not been captured yet.
            Everything beyond the track was never recoverable — a dead card or a customer who
            changed their mind — so chasing it would only have cost money.
          </p>
        </header>
        <div className="body">
          <div className="ceiling">
            <div className="track">
              <div className="fill" style={{ width: `${captured}%` }} />
              <div className="remainder" style={{ width: `${100 - captured}%` }} />
            </div>
            <div className="legend">
              <span className="mono">
                <span className="swatch" style={{ background: 'var(--ok)' }} />₹
                {rupees(m.recovered_value)} captured
              </span>
              <span className="mono">
                ₹{rupees(m.ceiling_value)} ceiling
                <span
                  className="swatch"
                  style={{ background: 'var(--rule-2)', marginLeft: 7, marginRight: 0 }}
                />
              </span>
            </div>
            <div className="legend">
              <span style={{ color: 'var(--ink-3)' }}>
                ₹{rupees(m.at_risk_value)} failed in total · ₹
                {rupees(Math.max(0, m.at_risk_value - m.ceiling_value))} of it was never recoverable
              </span>
              <span className="pill neutral">{num(m.abandoned)} closed out</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
